// Test backend for the end-to-end suite: waits for a local anvil node, deploys Etherdisk,
// installs Multicall3 (wagmi batches reads through it), then runs the Rust server
// against a fresh database. Stays in the foreground for Playwright's webServer.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const RPC = "http://127.0.0.1:8545";
const exe = process.platform === "win32" ? ".exe" : "";
// Foundry tools: from FOUNDRY_BIN or PATH.
const tool = (name) => (process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, name + exe) : name);
const server = process.env.ETHERDISK_SERVER_BIN ?? join(repo, "target/debug/etherdisk-server" + exe);

// Anvil account #0 deploys; it is a well-known test key, local chain only.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

for (let i = 0; ; i++) {
  try {
    await rpc("eth_chainId");
    break;
  } catch {
    if (i > 120) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
}

if ((await rpc("eth_getCode", [CONTRACT, "latest"])) === "0x") {
  // The testnet tiers, plus 8 GB listed but not on sale ("coming soon").
  const tiers = ["[1,2,4,8]", "[500000000000000,750000000000000,1000000000000000,2000000000000000]", "[true,true,true,false]"];
  execFileSync(tool("forge"), ["create", "src/Etherdisk.sol:Etherdisk", "--rpc-url", RPC, "--private-key", DEPLOYER_KEY, "--broadcast", "--constructor-args", DEPLOYER, ...tiers], {
    cwd: join(repo, "contracts"),
    stdio: "inherit",
  });
}
await rpc("anvil_setCode", [MULTICALL3, readFileSync(join(here, "fixtures/multicall3.hex"), "utf8").trim()]);

const data = mkdtempSync(join(tmpdir(), "etherdisk-e2e-"));
const child = spawn(server, [], {
  stdio: "inherit",
  env: {
    ...process.env,
    RPC_URL: RPC,
    CONTRACT_ADDRESS: CONTRACT,
    START_BLOCK: "0",
    CHAIN_ID: "11155111",
    CONFIRMATIONS: "0",
    BIND_ADDR: "127.0.0.1:8788",
    DATABASE_URL: `sqlite://${join(data, "etherdisk.db").replaceAll("\\", "/")}`,
    DATA_DIR: join(data, "blobs"),
    SIWE_DOMAIN: "localhost:3001",
    CORS_ORIGINS: "http://localhost:3001",
  },
});
const stop = () => {
  child.kill();
  rmSync(data, { recursive: true, force: true });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  rmSync(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
