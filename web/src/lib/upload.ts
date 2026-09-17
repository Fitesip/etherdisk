// Upload pipeline: the file is read, encrypted and sent chunk by chunk, so plaintext
// never leaves the browser and is never held in memory as a whole.

import { api, ApiError } from "./api";
import {
  chunkLocation,
  concat,
  defaultChunkSize,
  encryptedLen,
  fromB64,
  headerLen,
  toB64,
  WasmFileDecryptor,
  WasmFileEncryptor,
  type WasmVault,
} from "./crypto";
import { guessType } from "./format";
import { sealMeta, type FileMeta } from "./meta";
import { makeThumbnail } from "./thumbnail";

/** Crypto chunks per HTTP request (~8 MiB with the default 1 MiB chunks). */
const CHUNKS_PER_PART = 8;
const RETRIES = 3;
/** Poly1305 tag per chunk. */
const TAG_LEN = 16;

export interface UploadArgs {
  token: string;
  tokenId: string;
  vault: WasmVault;
  parentId: string | null;
  file: File;
  /** 0..1 */
  onProgress: (fraction: number) => void;
  /** Called with the file id once the upload exists on the server. */
  onStart?: (id: string) => void;
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

/** Thumbnail with a fresh header (never reuses a nonce), or null. */
async function thumbnailFor(vault: WasmVault, file: File, type: string, cs: number) {
  const blob = await makeThumbnail(file, type);
  return blob && blob.size <= cs ? encryptSmall(vault, new Uint8Array(await blob.arrayBuffer())) : null;
}

/**
 * Encrypts chunks `from..` of `file` and appends them at `offset`. `first` is prepended
 * to the first part (the header on a fresh upload).
 */
async function sendChunks(a: UploadArgs, id: string, enc: WasmFileEncryptor, cs: number, from: number, offset: number, total: number, first?: Uint8Array) {
  const { file } = a;
  const chunks = Math.max(1, Math.ceil(file.size / cs));
  let part: Uint8Array[] = first ? [first] : [];
  for (let i = from; i < chunks; i++) {
    a.signal?.throwIfAborted();
    const last = i === chunks - 1;
    const plain = new Uint8Array(await file.slice(i * cs, Math.min((i + 1) * cs, file.size)).arrayBuffer());
    part.push(enc.encryptChunk(plain, last));
    if (part.length >= CHUNKS_PER_PART || last) {
      const body = concat(part);
      await putPart(a, id, offset, body);
      offset += body.length;
      part = [];
      a.onProgress(offset / total);
    }
  }
}

/** Interrupted uploads stay on the server to be resumed; rejected ones are removed. */
const keepForResume = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

export async function uploadFile(a: UploadArgs): Promise<void> {
  const { file, vault } = a;
  const type = guessType(file.name, file.type);
  const cs = defaultChunkSize();
  const id = crypto.randomUUID();

  // Thumbnails are small: encrypted in one chunk.
  const thumb = await thumbnailFor(vault, file, type, cs);

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
      keyId: vault.keyId,
    };
    await api.createFile(a.token, a.tokenId, {
      id,
      parent_id: a.parentId,
      metadata: sealMeta(vault, id, meta),
      size,
      thumb_size: thumb?.bytes.length ?? null,
    });
    created = true;
    a.onStart?.(id);

    await sendChunks(a, id, enc, cs, 0, 0, size, header);
    if (thumb) await api.putThumbnail(a.token, a.tokenId, id, thumb.bytes);
    await api.complete(a.token, a.tokenId, id);
  } catch (e) {
    // Free the reserved quota now instead of waiting for the server's cleanup.
    if (created && !keepForResume(e)) api.remove(a.token, a.tokenId, id).catch(() => {});
    throw e;
  } finally {
    enc.free();
  }
}

/** An interrupted upload, as listed by the server, with its decrypted metadata. */
export interface ResumeTarget {
  id: string;
  meta: FileMeta;
  /** Encrypted size declared at the start. */
  encSize: number;
  /** Encrypted bytes the server already has. */
  received: number;
  hadThumbnail: boolean;
}

/**
 * Continues an interrupted upload of the same file. The chunk before the resume point is
 * encrypted again and compared with what the server stored: if the file differs, nothing
 * is sent (re-encrypting other data under the same nonces would break confidentiality).
 * Throws "mismatch" in that case.
 */
export async function resumeUpload(a: UploadArgs, r: ResumeTarget): Promise<void> {
  const { file, vault } = a;
  if (file.name !== r.meta.name || file.size !== r.meta.size || file.lastModified !== r.meta.mtime) throw new Error("mismatch");
  const header = fromB64(r.meta.header);
  const probe = WasmFileDecryptor.fromVault(vault, header);
  const cs = probe.chunkSize;
  probe.free();
  const step = cs + TAG_LEN;
  const hl = headerLen();

  // Parts carry whole chunks (the first one also the header), so `received` is a boundary.
  const done = r.received >= hl ? Math.floor((r.received - hl) / step) : 0;
  if (r.received < hl + step || (r.received - hl) % step !== 0 && r.received !== r.encSize) {
    // Too little to verify against: start over with a new header (and new nonces).
    await api.remove(a.token, a.tokenId, r.id);
    return uploadFile(a);
  }
  a.onStart?.(r.id);

  // Verify the last stored chunk.
  const chunks = Math.max(1, Math.ceil(file.size / cs));
  const check = Math.min(done, chunks) - 1;
  const [off, len, last] = chunkLocation(check, cs, BigInt(r.encSize));
  const stored = await api.contentRange(a.token, a.tokenId, r.id, Number(off), Number(off + len) - 1);
  const verifier = WasmFileEncryptor.resume(vault, header, check, r.meta.keyId);
  try {
    const plain = new Uint8Array(await file.slice(check * cs, Math.min((check + 1) * cs, file.size)).arrayBuffer());
    const again = verifier.encryptChunk(plain, last === 1n);
    if (again.length !== stored.length || again.some((b, i) => b !== stored[i])) throw new Error("mismatch");
  } finally {
    verifier.free();
  }

  a.onProgress(r.received / r.encSize);
  if (r.received < r.encSize) {
    const enc = WasmFileEncryptor.resume(vault, header, done, r.meta.keyId);
    try {
      await sendChunks(a, r.id, enc, cs, done, r.received, r.encSize);
    } finally {
      enc.free();
    }
  }

  // The thumbnail (if any) is made again with a fresh header, so its nonce is new. It shares
  // the file's key: if the drive got a new key since the upload began, go without one.
  if (r.hadThumbnail) {
    const thumb = r.meta.keyId === vault.keyId ? await thumbnailFor(vault, file, r.meta.type, cs) : null;
    const meta: FileMeta = { ...r.meta };
    delete meta.thumbHeader;
    if (thumb) meta.thumbHeader = toB64(thumb.header);
    await api.setMetadata(a.token, a.tokenId, r.id, sealMeta(vault, r.id, meta));
    if (thumb) await api.putThumbnail(a.token, a.tokenId, r.id, thumb.bytes);
    else await api.dropThumbnail(a.token, a.tokenId, r.id);
  }
  await api.complete(a.token, a.tokenId, r.id);
}
