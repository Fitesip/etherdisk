import { expect, test } from "@playwright/test";

import { ALICE, BOB, installWallet, mintAndSetUp, signIn, upload } from "./wallet";

const text = (name: string, content: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(content) });

test("landing shows the tiers from the contract", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Cloud storage you buy once/ })).toBeVisible();
  await expect(page.getByText("0.0005 ETH", { exact: true })).toBeVisible();
  await expect(page.getByText("Best value per GB")).toBeVisible();
});

test("drive: upload, search, trash with undo, password link", async ({ page, browser }) => {
  await installWallet(page, ALICE);
  await signIn(page);
  await mintAndSetUp(page);

  // Upload and see the files.
  await upload(page, [text("notes.txt", "hello from e2e"), text("report-2026.txt", "numbers")]);
  const list = page.locator("main ul").last();
  await expect(list.getByText("notes.txt")).toBeVisible();
  await expect(list.getByText("report-2026.txt")).toBeVisible();

  // Same name again: asked what to do; "Keep both" adds a copy.
  await upload(page, [text("notes.txt", "second")]);
  await page.getByRole("button", { name: "Keep both" }).click();
  await expect(list.getByText("notes (2).txt")).toBeVisible();

  // Search across the drive.
  await page.getByPlaceholder("Search this drive").fill("REPORT");
  await expect(page.getByText("Results for “REPORT”")).toBeVisible();
  await expect(list.getByText("report-2026.txt")).toBeVisible();
  await expect(list.getByText("notes.txt")).toHaveCount(0);
  await page.getByPlaceholder("Search this drive").fill("");

  // Trash with undo.
  await list.locator("li", { hasText: "notes (2).txt" }).getByRole("button", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(list.getByText("notes (2).txt")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(list.getByText("notes (2).txt")).toBeVisible();

  // Password link, opened by a stranger.
  await list.locator("li", { hasText: "notes.txt" }).first().getByRole("button", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Share link" }).click();
  await page.getByLabel(/Password/).fill("link-secret");
  await page.getByRole("button", { name: "Create link" }).click();
  const link = await page.locator("dialog[open] input[readonly]").inputValue();
  expect(link).toMatch(/\/s\/[0-9a-f]+#.+\.p$/);

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(link);
  await stranger.getByPlaceholder("Password").fill("wrong");
  await stranger.getByRole("button", { name: "Open" }).click();
  await expect(stranger.getByText("Wrong password")).toBeVisible();
  await stranger.getByPlaceholder("Password").fill("link-secret");
  await stranger.getByRole("button", { name: "Open" }).click();
  await stranger.getByRole("button", { name: /notes\.txt/ }).click();
  await expect(stranger.locator("dialog[open] pre")).toHaveText("hello from e2e");
});

test("transfer with the drive key: the new owner opens the files", async ({ browser }) => {
  // Bob turns on receiving drives.
  const bob = await (await browser.newContext()).newPage();
  await installWallet(bob, BOB);
  await signIn(bob);
  const turnOn = bob.getByRole("button", { name: "Turn on" });
  await turnOn.click();
  await expect(turnOn).toHaveCount(0);

  // Alice makes a drive with a file and sends it to Bob with its key.
  const alice = await (await browser.newContext()).newPage();
  await installWallet(alice, ALICE);
  await signIn(alice);
  const tokenId = await mintAndSetUp(alice);
  await upload(alice, [text("for-bob.txt", "the secret plan")]);
  await expect(alice.getByText("for-bob.txt").first()).toBeVisible();
  await alice.getByRole("button", { name: "Drive menu" }).click();
  await alice.getByRole("button", { name: "Transfer drive" }).click();
  const dialog = alice.locator("dialog[open]");
  await dialog.getByPlaceholder("0x…").fill(BOB);
  await dialog.locator("input:not([type=checkbox])").last().fill("TRANSFER");
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await dialog.getByRole("button", { name: "Transfer drive" }).click();
  await expect(alice).toHaveURL(/\/drive$/);

  // Bob receives the key, chooses his own passphrase and reads the file.
  await bob.goto(`/drive/${tokenId}`);
  await bob.getByRole("button", { name: "Receive key" }).click();
  await bob.getByPlaceholder("New passphrase").fill("Bobs#Pass2");
  await bob.getByPlaceholder("Repeat passphrase").fill("Bobs#Pass2");
  await bob.getByRole("button", { name: "Save and open drive" }).click();
  await bob.getByRole("button", { name: /for-bob\.txt/ }).click();
  await expect(bob.locator("dialog[open] pre")).toHaveText("the secret plan");
});

test("ideas: propose and vote, one vote per drive", async ({ page }) => {
  await installWallet(page, ALICE);
  await signIn(page);
  await page.goto("/ideas");
  await page.getByRole("button", { name: "Propose an idea" }).click();
  await page.getByLabel("Title").fill("Dark mode for shared pages");
  await page.getByRole("button", { name: "Publish" }).click();
  const card = page.locator("li", { hasText: "Dark mode for shared pages" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /^Vote · 0 votes/ }).click();
  // Alice still holds the drive from the first test: one drive, one vote.
  await expect(card.getByRole("button", { name: /^Voted · 1 votes/ })).toBeVisible();
  await card.getByRole("button", { name: /^Voted/ }).click();
  await expect(card.getByRole("button", { name: /^Vote · 0 votes/ })).toBeVisible();
});
