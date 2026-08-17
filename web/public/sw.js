// Streaming decryption service worker.
//
// The page registers a "stream" (ciphertext URL, file key, size, name, type) and then
// points <video>/<img>/<iframe>/a download at /__stream/{id}. This worker answers those
// requests: it fetches only the needed encrypted chunks with HTTP Range, decrypts them
// with the Rust crate (WASM) and streams plaintext back, honouring the caller's Range
// header so video seeking works and large downloads never sit in memory.
//
// Streams live in memory only. If the browser restarts this worker they are gone and
// requests get 404; the page re-registers and retries.

/* global wasm_bindgen */
importScripts("/crypto-sw/vault_crypto_wasm.js");
const wasmReady = wasm_bindgen({ module_or_path: "/crypto-sw/vault_crypto_wasm_bg.wasm" });

/** Chunks fetched per request (4 MiB with the default chunk size). */
const BATCH = 4;
const PREFIX = "/__stream/";

/** @type {Map<string, {url: string, token?: string | null, key: Uint8Array, encSize: number, name: string, type: string, header?: Uint8Array}>} */
const streams = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg?.type === "register") streams.set(msg.id, msg.stream);
  if (msg?.type === "unregister") streams.delete(msg.id);
  e.ports[0]?.postMessage("ok");
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(PREFIX)) {
    e.respondWith(handle(e.request, url).catch((err) => new Response(String(err), { status: 500 })));
  }
});

async function fetchRange(s, from, to) {
  const headers = { Range: `bytes=${from}-${to}` };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  const res = await fetch(s.url, { headers });
  if (res.status !== 206 && !(res.status === 200 && from === 0)) throw new Error(`upstream ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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

async function handle(request, url) {
  const id = url.pathname.slice(PREFIX.length);
  const s = streams.get(id);
  if (!s) return new Response("stream not registered", { status: 404 });
  await wasmReady;
  const W = wasm_bindgen;

  const headerLen = W.headerLen();
  if (!s.header) s.header = await fetchRange(s, 0, headerLen - 1);
  const dec = W.WasmFileDecryptor.fromKey(s.key, s.header);
  let freed = false;
  const free = () => {
    if (!freed) dec.free();
    freed = true;
  };

  const cs = dec.chunkSize;
  const encSize = BigInt(s.encSize);
  const size = Number(W.plaintextLen(encSize, cs));
  const disposition = url.searchParams.has("dl") ? "attachment" : "inline";
  const headers = {
    "Content-Type": s.type || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(s.name)}`,
    "Cache-Control": "no-store",
  };

  if (size === 0) {
    free();
    return new Response(null, { status: 200, headers: { ...headers, "Content-Length": "0" } });
  }
  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    free();
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const [start, end] = range ?? [0, size - 1];
  headers["Content-Length"] = String(end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

  const last = Math.floor(end / cs);
  let next = Math.floor(start / cs);
  const loc = (i) => W.chunkLocation(i, cs, encSize); // [offset, len, isLast]

  const body = new ReadableStream({
    async pull(ctrl) {
      try {
        if (next > last) {
          free();
          ctrl.close();
          return;
        }
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
          ctrl.enqueue(plain.subarray(Math.max(0, start - base), Math.min(plain.length, end - base + 1)));
        }
        next = batchEnd + 1;
      } catch (err) {
        free();
        ctrl.error(err);
      }
    },
    cancel: free,
  });

  return new Response(body, { status: range ? 206 : 200, headers });
}
