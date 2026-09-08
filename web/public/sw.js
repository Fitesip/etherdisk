// Streaming decryption service worker.
//
// The page registers a "stream" (ciphertext URL, file key, size, name, type) and then
// points <video>/<img>/<iframe>/a download at /__stream/{id}. This worker answers those
// requests: it fetches only the needed encrypted chunks with HTTP Range, decrypts them
// with the Rust crate (WASM) and streams plaintext back, honouring the caller's Range
// header so video seeking works and large downloads never sit in memory.
//
// It also builds ZIP archives on the fly (/__zip/{id}): several streams are decrypted
// one after another into an uncompressed ZIP, so folders download as one file without
// ever being held in memory.
//
// Registrations live in memory only. If the browser restarts this worker they are gone
// and requests get 404; the page re-registers and retries.

/* global wasm_bindgen */
importScripts("/crypto-sw/etherdisk_crypto_wasm.js");
const wasmReady = wasm_bindgen({ module_or_path: "/crypto-sw/etherdisk_crypto_wasm_bg.wasm" });

/** Chunks fetched per request (4 MiB with the default chunk size). */
const BATCH = 4;
const STREAM = "/__stream/";
const ZIP = "/__zip/";

/** @type {Map<string, {url: string, token?: string | null, key: Uint8Array, encSize: number, name: string, type: string, header?: Uint8Array}>} */
const streams = new Map();
/** @type {Map<string, {name: string, entries: {path: string, size: number, mtime: number, src: any}[]}>} */
const zips = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg?.type === "register") streams.set(msg.id, msg.stream);
  if (msg?.type === "unregister") streams.delete(msg.id);
  if (msg?.type === "register-zip") zips.set(msg.id, msg.zip);
  e.ports[0]?.postMessage("ok");
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const fail = (err) => new Response(String(err), { status: 500 });
  if (url.pathname.startsWith(STREAM)) e.respondWith(handleStream(e.request, url).catch(fail));
  else if (url.pathname.startsWith(ZIP)) e.respondWith(handleZip(url).catch(fail));
});

// ------------------------------------------------------------------ decryption

async function fetchRange(s, from, to) {
  const headers = { Range: `bytes=${from}-${to}` };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  const res = await fetch(s.url, { headers });
  if (res.status !== 206 && !(res.status === 200 && from === 0)) throw new Error(`upstream ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Opens a stream for decryption: its plaintext size and a generator of plaintext bytes. */
async function openStream(s) {
  await wasmReady;
  const W = wasm_bindgen;
  if (!s.header) s.header = await fetchRange(s, 0, W.headerLen() - 1);
  const probe = W.WasmFileDecryptor.fromKey(s.key, s.header);
  const cs = probe.chunkSize;
  probe.free();
  const encSize = BigInt(s.encSize);
  const size = Number(W.plaintextLen(encSize, cs));

  /** Plaintext bytes start..=end, decrypted batch by batch. */
  async function* range(start, end) {
    if (size === 0 || start > end) return;
    const dec = W.WasmFileDecryptor.fromKey(s.key, s.header);
    try {
      const loc = (i) => W.chunkLocation(i, cs, encSize); // [offset, len, isLast]
      const last = Math.floor(end / cs);
      for (let next = Math.floor(start / cs); next <= last; ) {
        const batchEnd = Math.min(last, next + BATCH - 1);
        const a = loc(next);
        const b = loc(batchEnd);
        const from = Number(a[0]);
        const buf = await fetchRange(s, from, Number(b[0]) + Number(b[1]) - 1);
        for (let i = next; i <= batchEnd; i++) {
          const l = loc(i);
          const off = Number(l[0]) - from;
          const plain = dec.decryptChunk(i, buf.subarray(off, off + Number(l[1])), l[2] === 1n);
          const base = i * cs;
          yield plain.subarray(Math.max(0, start - base), Math.min(plain.length, end - base + 1));
        }
        next = batchEnd + 1;
      }
    } finally {
      dec.free();
    }
  }
  return { size, range };
}

/** Response body from an async generator of byte arrays. */
function bodyFrom(gen) {
  return new ReadableStream({
    async pull(ctrl) {
      try {
        const { value, done } = await gen.next();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      } catch (err) {
        ctrl.error(err);
      }
    },
    cancel() {
      gen.return(undefined);
    },
  });
}

/** Single-range parser. Returns [start, end] inclusive, null for "whole", or "invalid". */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return [start, end];
}

const disposition = (kind, name) => `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`;

// Decrypted files come from other people (shared links) and could be HTML or SVG with
// scripts. Opened directly (e.g. "open image in new tab") they would run on this origin
// with access to sessions and keys. So inline types are limited to passive media, and
// every response is sandboxed: no scripts, opaque origin. PDFs are the exception the
// built-in viewer needs; it doesn't run page scripts.
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/[\w.+-]+|audio\/[\w.+-]+|text\/plain|application\/pdf)$/i;
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'";

function safeHeaders(type, inline, name) {
  const t = (type || "").toLowerCase();
  const shown = inline && INLINE_TYPES.test(t);
  const headers = {
    // Text is served as plain text; anything else not on the list only downloads.
    "Content-Type": shown ? (t.startsWith("text/") ? "text/plain; charset=utf-8" : t) : "application/octet-stream",
    "Content-Disposition": disposition(shown ? "inline" : "attachment", name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (t !== "application/pdf") headers["Content-Security-Policy"] = SANDBOX;
  return headers;
}

async function handleStream(request, url) {
  const s = streams.get(url.pathname.slice(STREAM.length));
  if (!s) return new Response("stream not registered", { status: 404 });
  const { size, range } = await openStream(s);
  const headers = { ...safeHeaders(s.type, !url.searchParams.has("dl"), s.name), "Accept-Ranges": "bytes" };
  if (size === 0) return new Response(null, { status: 200, headers: { ...headers, "Content-Length": "0" } });

  const r = parseRange(request.headers.get("range"), size);
  if (r === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const [start, end] = r ?? [0, size - 1];
  headers["Content-Length"] = String(end - start + 1);
  if (r) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(bodyFrom(range(start, end)), { status: r ? 206 : 200, headers });
}

// ------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc, bytes) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Little-endian byte writer. */
class Buf {
  constructor(n) {
    this.b = new Uint8Array(n);
    this.v = new DataView(this.b.buffer);
    this.o = 0;
  }
  u16(x) {
    this.v.setUint16(this.o, x, true);
    this.o += 2;
    return this;
  }
  u32(x) {
    this.v.setUint32(this.o, x >>> 0, true);
    this.o += 4;
    return this;
  }
  u64(x) {
    this.v.setBigUint64(this.o, BigInt(x), true);
    this.o += 8;
    return this;
  }
  bytes(a) {
    this.b.set(a, this.o);
    this.o += a.length;
    return this;
  }
}

function dosTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX32 = 0xffffffff;
const enc = new TextEncoder();

/**
 * Uncompressed ZIP with data descriptors (CRC is known only after streaming a file),
 * UTF-8 names, and ZIP64 records when sizes, offsets or the entry count need them.
 */
async function* zipStream(entries, zip64) {
  const central = [];
  let offset = 0;
  const flags = 0x0008 | 0x0800; // data descriptor + UTF-8 names
  const version = zip64 ? 45 : 20;

  for (const e of entries) {
    const name = enc.encode(e.path);
    const { time, date } = dosTime(e.mtime);
    const local = new Buf(30 + name.length + (zip64 ? 20 : 0))
      .u32(0x04034b50)
      .u16(version)
      .u16(flags)
      .u16(0) // stored
      .u16(time)
      .u16(date)
      .u32(0) // crc: in the data descriptor
      .u32(zip64 ? MAX32 : 0)
      .u32(zip64 ? MAX32 : 0)
      .u16(name.length)
      .u16(zip64 ? 20 : 0)
      .bytes(name);
    if (zip64) local.u16(0x0001).u16(16).u64(0).u64(0);
    yield local.b;
    const headerOffset = offset;
    offset += local.b.length;

    let crc = 0;
    let written = 0;
    if (e.src) {
      const { size, range } = await openStream(e.src);
      for await (const part of range(0, size - 1)) {
        crc = crc32(crc, part);
        written += part.length;
        yield part;
      }
    }
    offset += written;

    const desc = zip64 ? new Buf(24).u32(0x08074b50).u32(crc).u64(written).u64(written) : new Buf(16).u32(0x08074b50).u32(crc).u32(written).u32(written);
    yield desc.b;
    offset += desc.b.length;
    central.push({ name, crc, size: written, headerOffset, time, date });
  }

  const cdStart = offset;
  for (const c of central) {
    const extra = zip64 ? 28 : 0;
    const rec = new Buf(46 + c.name.length + extra)
      .u32(0x02014b50)
      .u16(version) // made by
      .u16(version)
      .u16(flags)
      .u16(0)
      .u16(c.time)
      .u16(c.date)
      .u32(c.crc)
      .u32(zip64 ? MAX32 : c.size)
      .u32(zip64 ? MAX32 : c.size)
      .u16(c.name.length)
      .u16(extra)
      .u16(0) // comment
      .u16(0) // disk
      .u16(0) // internal attrs
      .u32(0) // external attrs
      .u32(zip64 ? MAX32 : c.headerOffset)
      .bytes(c.name);
    if (zip64) rec.u16(0x0001).u16(24).u64(c.size).u64(c.size).u64(c.headerOffset);
    yield rec.b;
    offset += rec.b.length;
  }
  const cdSize = offset - cdStart;

  if (zip64) {
    const eocd64 = offset;
    yield new Buf(56)
      .u32(0x06064b50)
      .u64(44)
      .u16(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(central.length)
      .u64(central.length)
      .u64(cdSize)
      .u64(cdStart).b;
    yield new Buf(20).u32(0x07064b50).u32(0).u64(eocd64).u32(1).b;
  }
  yield new Buf(22)
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(zip64 ? 0xffff : central.length)
    .u16(zip64 ? 0xffff : central.length)
    .u32(zip64 ? MAX32 : cdSize)
    .u32(zip64 ? MAX32 : cdStart)
    .u16(0).b;
}

/** Exact archive size from the known plaintext sizes, so the browser shows progress. */
function zipSize(entries, zip64) {
  let n = 0;
  for (const e of entries) {
    const name = enc.encode(e.path).length;
    n += 30 + name + (zip64 ? 20 : 0) + e.size + (zip64 ? 24 : 16) + 46 + name + (zip64 ? 28 : 0);
  }
  return n + (zip64 ? 56 + 20 : 0) + 22;
}

async function handleZip(url) {
  const z = zips.get(url.pathname.slice(ZIP.length));
  if (!z) return new Response("zip not registered", { status: 404 });
  const total = z.entries.reduce((n, e) => n + e.size, 0);
  const zip64 = z.entries.length > 0xfffe || total + z.entries.length * 1024 > 0xfffffff0;
  return new Response(bodyFrom(zipStream(z.entries, zip64)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zipSize(z.entries, zip64)),
      "Content-Disposition": disposition("attachment", z.name),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": SANDBOX,
    },
  });
}
