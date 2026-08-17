// Upload pipeline: the file is read, encrypted and sent chunk by chunk, so plaintext
// never leaves the browser and is never held in memory as a whole.

import { api, ApiError } from "./api";
import {
  concat,
  defaultChunkSize,
  encryptedLen,
  toB64,
  WasmFileEncryptor,
  type WasmVault,
} from "./crypto";
import { guessType } from "./format";
import { sealMeta, type FileMeta } from "./meta";
import { makeThumbnail } from "./thumbnail";

/** Crypto chunks per HTTP request (~8 MiB with the default 1 MiB chunks). */
const CHUNKS_PER_PART = 8;
const RETRIES = 3;

export interface UploadArgs {
  token: string;
  tokenId: string;
  vault: WasmVault;
  parentId: string | null;
  file: File;
  /** 0..1 */
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}

function encryptSmall(vault: WasmVault, data: Uint8Array): { header: Uint8Array; bytes: Uint8Array<ArrayBuffer> } {
  const enc = new WasmFileEncryptor(vault, defaultChunkSize());
  try {
    const header = enc.header;
    return { header, bytes: concat([header, enc.encryptChunk(data, true)]) };
  } finally {
    enc.free();
  }
}

/** Sends one part; a failed part is rolled back by the server, so it is simply retried. */
async function putPart(a: UploadArgs, id: string, offset: number, body: Uint8Array<ArrayBuffer>) {
  for (let attempt = 1; ; attempt++) {
    a.signal?.throwIfAborted();
    try {
      await api.putContent(a.token, a.tokenId, id, offset, body);
      return;
    } catch (e) {
      // The previous attempt may have succeeded with the response lost.
      if (e instanceof ApiError && e.status === 409 && e.message === `expected offset ${offset + body.length}`) return;
      const retriable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!retriable || attempt >= RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function uploadFile(a: UploadArgs): Promise<void> {
  const { file, vault } = a;
  const type = guessType(file.name, file.type);
  const cs = defaultChunkSize();
  const id = crypto.randomUUID();

  // Thumbnails are small: encrypted in one chunk.
  let thumb: { header: Uint8Array; bytes: Uint8Array<ArrayBuffer> } | null = null;
  const thumbBlob = await makeThumbnail(file, type);
  if (thumbBlob && thumbBlob.size <= cs) thumb = encryptSmall(vault, new Uint8Array(await thumbBlob.arrayBuffer()));

  const enc = new WasmFileEncryptor(vault, cs);
  let created = false;
  try {
    const header = enc.header;
    const size = Number(encryptedLen(BigInt(file.size), cs));
    const meta: FileMeta = {
      v: 1,
      name: file.name,
      type,
      size: file.size,
      mtime: file.lastModified,
      header: toB64(header),
      ...(thumb && { thumbHeader: toB64(thumb.header) }),
    };
    await api.createFile(a.token, a.tokenId, {
      id,
      parent_id: a.parentId,
      metadata: sealMeta(vault, id, meta),
      size,
      thumb_size: thumb?.bytes.length ?? null,
    });
    created = true;

    const chunks = Math.max(1, Math.ceil(file.size / cs));
    let offset = 0;
    let part: Uint8Array[] = [header];
    for (let i = 0; i < chunks; i++) {
      a.signal?.throwIfAborted();
      const last = i === chunks - 1;
      const plain = new Uint8Array(await file.slice(i * cs, Math.min((i + 1) * cs, file.size)).arrayBuffer());
      part.push(enc.encryptChunk(plain, last));
      if (part.length >= CHUNKS_PER_PART || last) {
        const body = concat(part);
        await putPart(a, id, offset, body);
        offset += body.length;
        part = [];
        a.onProgress(offset / size);
      }
    }

    if (thumb) await api.putThumbnail(a.token, a.tokenId, id, thumb.bytes);
    await api.complete(a.token, a.tokenId, id);
  } catch (e) {
    // Free the reserved quota now instead of waiting for the server's cleanup.
    if (created) api.remove(a.token, a.tokenId, id).catch(() => {});
    throw e;
  } finally {
    enc.free();
  }
}
