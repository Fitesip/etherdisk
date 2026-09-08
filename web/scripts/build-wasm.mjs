// Builds the Rust crypto crate to WASM twice:
//  - `web` target  -> src/wasm/        (imported by the app; the .wasm is served from public/crypto/)
//  - `no-modules`  -> public/crypto-sw/ (loaded by the service worker via importScripts)
// Skips the build when the outputs are newer than the crate sources.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crates = resolve(web, "../crates");
const crate = join(crates, "etherdisk-crypto-wasm");
const appOut = join(web, "src/wasm");
const swOut = join(web, "public/crypto-sw");
const wasmPublic = join(web, "public/crypto");
const WASM = "etherdisk_crypto_wasm_bg.wasm";

function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name === "pkg") continue;
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

const outputs = [join(appOut, WASM), join(swOut, WASM), join(wasmPublic, WASM)];
const src = Math.max(newest(join(crates, "etherdisk-crypto")), newest(crate));
if (!process.argv.includes("--force") && outputs.every((f) => existsSync(f) && statSync(f).mtimeMs > src)) {
  console.log("wasm: up to date");
  process.exit(0);
}

const pack = (target, out) =>
  execFileSync("wasm-pack", ["build", crate, "--release", "--target", target, "--out-dir", out, "--no-pack"], { stdio: "inherit" });
pack("web", appOut);
pack("no-modules", swOut);
mkdirSync(wasmPublic, { recursive: true });
copyFileSync(join(appOut, WASM), join(wasmPublic, WASM));
console.log("wasm: built");
