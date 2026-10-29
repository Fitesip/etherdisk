// Test backend for the end-to-end suite: waits for a local anvil node, deploys Etherdisk
// (after a previous version with one drive on it, to move), installs Multicall3 (wagmi
// batches reads through it), then runs the Rust server against a fresh database. Stays in the foreground for Playwright's webServer.
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
const RENDERER = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const CONTRACT = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// The previous contract, from anvil account #9 (its own nonces: CONTRACT keeps its address).
const LEGACY_DEPLOYER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const LEGACY_DEPLOYER = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const LEGACY_RENDERER = "0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35";
export const LEGACY = "0xA15BB66138824a1c7167f5E85b957d04Dd34E468";
// Anvil account #3 (CAROL in wallet.ts) holds drive #1 on it.
const CAROL_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const ZERO = "0x0000000000000000000000000000000000000000";

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
  const create = (key, contract, ...args) =>
    execFileSync(tool("forge"), ["create", contract, "--rpc-url", RPC, "--private-key", key, "--broadcast", "--constructor-args", ...args], {
      cwd: join(repo, "contracts"),
      stdio: "inherit",
    });
  const send = (key, to, sig, ...args) =>
    execFileSync(tool("cast"), ["send", to, sig, ...args, "--rpc-url", RPC, "--private-key", key], { stdio: "ignore" });
  // The testnet tiers, plus 8 GB listed but not on sale ("coming soon"); 5% royalty.
  const tiers = ["[1,2,4,8]", "[500000000000000,750000000000000,1000000000000000,2000000000000000]", "[true,true,true,false]", "[6514417,1096065,16096779,15485081]"];

  // The previous version: Carol's drive #1, then its sales close for good.
  create(LEGACY_DEPLOYER_KEY, "src/EtherdiskRenderer.sol:EtherdiskRenderer", "http://localhost:3001/nft/");
  create(LEGACY_DEPLOYER_KEY, "src/Etherdisk.sol:Etherdisk", LEGACY_DEPLOYER, LEGACY_RENDERER, ...tiers, "500", ZERO);
  send(CAROL_KEY, LEGACY, "mint(uint256)", "0", "--value", "500000000000000");
  send(LEGACY_DEPLOYER_KEY, LEGACY, "closeSales()");

  // Deployer nonce 0: the renderer (at RENDERER); nonce 1: Etherdisk (at CONTRACT), taking
  // the previous version's drives.
  create(DEPLOYER_KEY, "src/EtherdiskRenderer.sol:EtherdiskRenderer", "http://localhost:3001/nft/");
  create(DEPLOYER_KEY, "src/Etherdisk.sol:Etherdisk", DEPLOYER, RENDERER, ...tiers, "500", LEGACY);
  send(DEPLOYER_KEY, CONTRACT, "setMigrationOpen(bool)", "true");
}
await rpc("anvil_setCode", [MULTICALL3, readFileSync(join(here, "fixtures/multicall3.hex"), "utf8").trim()]);

const data = mkdtempSync(join(tmpdir(), "etherdisk-e2e-"));
const child = spawn(server, [], {
  stdio: "inherit",
  env: {
    ...process.env,
    RPC_URL: RPC,
    CONTRACT_ADDRESS: CONTRACT,
    LEGACY_CONTRACT_ADDRESS: LEGACY,
    START_BLOCK: "0",
    CHAIN_ID: "11155111",
    CONFIRMATIONS: "0",
    BIND_ADDR: "127.0.0.1:8788",
    DATABASE_URL: `sqlite://${join(data, "etherdisk.db").replaceAll("\\", "/")}`,
    DATA_DIR: join(data, "blobs"),
    // Each test drive would take its capacity of real disk (covered by the server tests);
    // E2E_RESERVE_SPACE=true shows a short drive on a nearly full disk.
    RESERVE_SPACE: process.env.E2E_RESERVE_SPACE ?? "false",
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
