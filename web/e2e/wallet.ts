import { expect, type Page } from "@playwright/test";

/** Anvil's default accounts (#1, #2, #3): local test chain only. */
export const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
/** Holds drive #1 on the previous contract (e2e/api.mjs). */
export const CAROL = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

/**
 * Installs an injected wallet (EIP-1193 + EIP-6963) before the app loads. Requests go
 * straight to anvil, which holds the keys of its unlocked accounts, so signing and
 * sending transactions need no popups.
 */
export async function installWallet(page: Page, account: string) {
  await page.addInitScript((acc) => {
    let id = 0;
    const rpc = async (method: string, params: unknown[] = []) => {
      const r = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    };
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [acc];
        if (["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_revokePermissions"].includes(method)) return null;
        if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        if (method === "eth_sendTransaction") params = [{ ...(params![0] as object), from: acc }];
        return rpc(method, params);
      },
      on: () => provider,
      removeListener: () => provider,
    };
    const info = { uuid: "a4b0e8c4-1111-4111-8111-000000000001", name: "Anvil Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "dev.anvil.test" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    (window as unknown as { ethereum: unknown }).ethereum = provider;
  }, account);
}

/** Opens the drives page, connects the test wallet and signs in. */
export async function signIn(page: Page) {
  await page.goto("/drive");
  const connect = page.getByRole("button", { name: "Connect wallet" }).first();
  const sign = page.getByRole("button", { name: "Sign message" });
  await expect(connect.or(sign).or(page.getByRole("heading", { name: "Your drives" }))).toBeVisible();
  if (await connect.isVisible()) {
    // wagmi may reconnect the wallet on its own meanwhile, and the button goes away.
    await connect.click({ timeout: 5_000 }).catch(() => {});
    await page.getByRole("button", { name: "Anvil Test Wallet" }).click({ timeout: 5_000 }).catch(() => {});
  }
  if (await sign.isVisible().catch(() => false)) await sign.click();
  else await sign.click({ timeout: 5_000 }).catch(() => {});
  await expect(page.getByRole("heading", { name: "Your drives" })).toBeVisible();
}

export const PASSPHRASE = "Good#Pass1";

/**
 * Mints a 1 GB drive and sets it up; leaves the page inside the (unlocked) drive.
 */
export async function mintAndSetUp(page: Page): Promise<string> {
  const before = await page.locator('a[href^="/drive/"]').count();
  await page.getByRole("button", { name: /Mint for 0\.0005 ETH/ }).click();
  await expect(page.locator('a[href^="/drive/"]')).toHaveCount(before + 1);
  const link = page.locator('a[href^="/drive/"]').last();
  const href = (await link.getAttribute("href"))!;
  await link.click();
  // Wait for this drive's setup form: during the navigation another drive's unlock form
  // (also a "Passphrase" field) can still be on screen for a moment.
  await expect(page.getByRole("heading", { name: /^Set up / })).toBeVisible();
  await page.locator('input[placeholder="Passphrase"][autocomplete="new-password"]').fill(PASSPHRASE);
  await page.getByPlaceholder("Repeat passphrase").fill(PASSPHRASE);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create drive" }).click();
  await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
  return href.split("/").pop()!;
}

/** Uploads files through the hidden file input. */
export async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type="file"][multiple]:not([webkitdirectory]):not([capture])').setInputFiles(files);
}
