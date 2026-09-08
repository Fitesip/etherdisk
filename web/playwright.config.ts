import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against a local chain (anvil), the real Rust server and the built app.
// Locally: `cargo build -p etherdisk-server`, then `npm run e2e` (Foundry on PATH or FOUNDRY_BIN).
const CI = !!process.env.CI;
const anvil = process.env.FOUNDRY_BIN ? `"${process.env.FOUNDRY_BIN}/anvil"` : "anvil";

export const APP_ENV = {
  NEXT_PUBLIC_API_URL: "http://localhost:8788",
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545",
  NEXT_PUBLIC_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
};

export default defineConfig({
  testDir: "e2e",
  // One chain and one server for all tests: run them in order.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    { command: `${anvil} --chain-id 11155111 --port 8545 --silent`, port: 8545, reuseExistingServer: !CI },
    { command: "node e2e/api.mjs", port: 8788, reuseExistingServer: !CI, timeout: 180_000 },
    {
      // The app is built with the test env (NEXT_PUBLIC_* are inlined at build time).
      command: "npx next start -p 3001",
      port: 3001,
      reuseExistingServer: !CI,
      env: APP_ENV,
      timeout: 120_000,
    },
  ],
});
