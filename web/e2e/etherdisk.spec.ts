import { expect, test } from "@playwright/test";

import { ALICE, BOB, installWallet, mintAndSetUp, PASSPHRASE, signIn, upload } from "./wallet";

const text = (name: string, content: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(content) });

test("landing shows the tiers from the contract", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Cloud storage you buy once/ })).toBeVisible();
  await expect(page.getByText("0.0005 ETH", { exact: true })).toBeVisible();
  await expect(page.getByText("Best value per GB")).toBeVisible();
  // A tier that isn't on sale yet is listed (with its drive picture), without a way to buy it.
  const tiers = page.locator("section", { has: page.getByRole("heading", { name: "Pay once. Keep it." }) });
  await expect(tiers.getByText("8 GB", { exact: true }).and(tiers.locator("div"))).toBeVisible();
  await expect(tiers.getByRole("img", { name: "Etherdisk 8 GB" })).toBeVisible();
  await expect(page.getByText("Coming soon").first()).toBeVisible();
  // The legal pages, from the footer.
  await page.getByRole("link", { name: "Terms of Service" }).click();
  await expect(page.getByRole("heading", { name: "Etherdisk Terms of Service" })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "Privacy Policy" }).click();
  await expect(page.getByRole("heading", { name: "Etherdisk Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
});

test("drive: upload, search, trash with undo, password link", async ({ page, browser }) => {
  await installWallet(page, ALICE);
  await signIn(page);
  await mintAndSetUp(page);

  // A one-file list is short: the actions menu still shows in full, not clipped by the list.
  await upload(page, [text("notes.txt", "hello from e2e")]);
  const list = page.locator("main ul").last();
  await list.locator("li", { hasText: "notes.txt" }).getByRole("button", { name: "Actions" }).click();
  await expect(page.getByRole("button", { name: "Delete" })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Rename" }).click();
  await page.keyboard.press("Escape");

  // Upload and see the files.
  await upload(page, [text("report-2026.txt", "numbers")]);
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
  // Transfer lives in the drive's settings only (client-side navigation keeps it unlocked).
  await alice.getByRole("button", { name: "Drive menu" }).click();
  await expect(alice.getByRole("button", { name: "Transfer drive" })).toHaveCount(0);
  await alice.getByRole("button", { name: "Drive settings" }).click();
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

  // The drive now has a key alice never had; bob's own files and hers both open.
  await bob.keyboard.press("Escape");
  await upload(bob, [text("bobs.txt", "added by bob")]);
  await bob.getByRole("button", { name: /bobs\.txt/ }).click();
  await expect(bob.locator("dialog[open] pre")).toHaveText("added by bob");
});

test("ideas: propose, vote for and against, not on your own idea", async ({ page, browser }) => {
  await installWallet(page, ALICE);
  await signIn(page);
  await page.goto("/ideas");
  await page.getByRole("button", { name: "Propose an idea" }).click();
  await page.getByLabel("Title").fill("Dark mode for shared pages");
  await page.getByRole("button", { name: "Publish" }).click();
  const card = page.locator("li", { hasText: "Dark mode for shared pages" });
  await expect(card).toBeVisible();
  // The author can't vote on their own idea.
  await expect(card.getByRole("button", { name: "Vote for" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Vote against" })).toBeDisabled();

  // Bob holds the drive from the transfer test: one drive, one vote.
  const bob = await (await browser.newContext()).newPage();
  await installWallet(bob, BOB);
  await signIn(bob);
  const his = bob.locator("li", { hasText: "Dark mode for shared pages" });
  const score = (n: number) => his.getByLabel(new RegExp(`^Score ${n}:`));
  // Bob counts as the holder once the indexer has seen the transfer (one poll, ~12 s).
  await expect(async () => {
    await bob.goto("/ideas");
    await expect(his.getByRole("button", { name: "Vote for" })).toBeEnabled({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await his.getByRole("button", { name: "Vote for" }).click();
  await expect(score(1)).toBeVisible();
  await expect(his.getByRole("button", { name: "You voted for" })).toHaveAttribute("aria-pressed", "true");
  // Switching sides moves the vote; clicking it again withdraws it.
  await his.getByRole("button", { name: "Vote against" }).click();
  await expect(score(-1)).toBeVisible();
  await his.getByRole("button", { name: "You voted against" }).click();
  await expect(score(0)).toBeVisible();
});

test("recovery key: save the words, forget the passphrase, open the drive with them", async ({ page }) => {
  await installWallet(page, ALICE);
  await signIn(page);
  await mintAndSetUp(page);
  await upload(page, [text("keep-me.txt", "still here")]);

  // The drive suggests a recovery key; the words come with a download.
  await page.getByRole("button", { name: "Create recovery key" }).click();
  const dialog = page.locator("dialog[open]");
  const items = dialog.locator("ol li span:last-child");
  await expect(items).toHaveCount(24);
  const words = await items.allTextContents();
  const [file] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download" }).click()]);
  expect(file.suggestedFilename()).toMatch(/^etherdisk-recovery-drive-\d+\.txt$/);
  const sheet = await new Promise<string>((resolve) => file.createReadStream().then((s) => {
    let out = "";
    s.on("data", (c) => (out += c));
    s.on("end", () => resolve(out));
  }));
  expect(sheet).toContain(`24. ${words[23]}`);

  // Closing before the check warns that the downloaded words don't work yet; reopening
  // shows the same words, so the file stays valid.
  await page.keyboard.press("Escape");
  await expect(dialog.getByText(/isn't saved yet/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close anyway" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("button", { name: "Create recovery key" }).click();
  await expect(items).toHaveCount(24);
  expect(await items.allTextContents()).toEqual(words);

  // Asked back for three of them; a wrong answer is caught.
  await dialog.getByRole("button", { name: "I saved them" }).click();
  const fields = dialog.getByLabel(/^Word \d+$/);
  await expect(fields).toHaveCount(3);
  for (let i = 0; i < 3; i++) await fields.nth(i).fill("wrong");
  await dialog.getByRole("button", { name: "Save recovery key" }).click();
  await expect(dialog.getByText(/not what's in your copy/)).toBeVisible();
  const labels = dialog.locator("label");
  for (let i = 0; i < 3; i++) {
    const n = Number((await labels.nth(i).innerText()).match(/\d+/)![0]);
    await labels.nth(i).locator("input").fill(words[n - 1]);
  }
  await dialog.getByRole("button", { name: "Save recovery key" }).click();
  await expect(page.getByRole("button", { name: "Create recovery key" })).toHaveCount(0);

  // Passphrase forgotten: lock, then open with the words and a new passphrase.
  await page.getByRole("button", { name: "Drive menu" }).click();
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByRole("button", { name: /Forgot the passphrase/ }).click();
  const box = page.getByLabel("Recovery words");
  await box.fill(words.slice(0, 23).join(" "));
  await expect(page.getByText("24 valid words")).toHaveCount(0);
  await box.fill(words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join("\n"));
  await expect(page.getByText("24 valid words")).toBeVisible();
  await page.getByPlaceholder("New passphrase").fill("Fresh#Pass9");
  await page.getByPlaceholder("Repeat passphrase").fill("Fresh#Pass9");
  await page.getByRole("button", { name: "Open the drive" }).click();
  await page.getByRole("button", { name: /keep-me\.txt/ }).click();
  await expect(page.locator("dialog[open] pre")).toHaveText("still here");

  // The new passphrase works; the old one doesn't.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Drive menu" }).click();
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByPlaceholder("Passphrase", { exact: true }).filter({ visible: true }).fill("Good#Pass1");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Wrong passphrase")).toBeVisible();
  await page.getByPlaceholder("Passphrase", { exact: true }).filter({ visible: true }).fill("Fresh#Pass9");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
});

test("transfer with the passphrase: the new owner makes the drive theirs", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await installWallet(alice, ALICE);
  await signIn(alice);
  const tokenId = await mintAndSetUp(alice);
  await upload(alice, [text("told.txt", "shared by passphrase")]);
  await expect(alice.getByText("told.txt").first()).toBeVisible();
  await alice.getByRole("button", { name: "Drive menu" }).click();
  await alice.getByRole("button", { name: "Drive settings" }).click();
  await alice.getByRole("button", { name: "Transfer drive" }).click();
  const dialog = alice.locator("dialog[open]");
  await dialog.getByPlaceholder("0x…").fill(BOB);
  await dialog.locator("input:not([type=checkbox])").last().fill("TRANSFER");
  await dialog.getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Transfer drive" }).click();
  await expect(alice).toHaveURL(/\/drive$/);

  // Bob unlocks with alice's passphrase and is asked for his own before seeing the files.
  const bob = await (await browser.newContext()).newPage();
  await installWallet(bob, BOB);
  await signIn(bob);
  await bob.goto(`/drive/${tokenId}`);
  await bob.getByPlaceholder("Passphrase", { exact: true }).filter({ visible: true }).fill(PASSPHRASE);
  await bob.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(bob.getByRole("heading", { name: /yours$/ })).toBeVisible();
  await bob.getByPlaceholder("New passphrase").fill("Mine#Now7");
  await bob.getByPlaceholder("Repeat passphrase").fill("Mine#Now7");
  await bob.getByRole("button", { name: "Save and open" }).click();
  await bob.getByRole("button", { name: /told\.txt/ }).click();
  await expect(bob.locator("dialog[open] pre")).toHaveText("shared by passphrase");

  // Alice's passphrase no longer opens it; bob's does, without asking again.
  await bob.keyboard.press("Escape");
  await bob.getByRole("button", { name: "Drive menu" }).click();
  await bob.getByRole("button", { name: "Lock", exact: true }).click();
  await bob.getByPlaceholder("Passphrase", { exact: true }).filter({ visible: true }).fill(PASSPHRASE);
  await bob.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(bob.getByText("Wrong passphrase")).toBeVisible();
  await bob.getByPlaceholder("Passphrase", { exact: true }).filter({ visible: true }).fill("Mine#Now7");
  await bob.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(bob.getByRole("button", { name: /told\.txt/ })).toBeVisible();
});

test("customization: drive icon and cover, starred files, labels, folder color and icon", async ({ page }) => {
  await installWallet(page, ALICE);
  await signIn(page);
  const tokenId = await mintAndSetUp(page);
  // The file list (the uploads panel has a list too).
  const list = page.locator("main ul").filter({ has: page.getByRole("checkbox", { name: /^Select / }) });
  const row = (name: string) => list.locator("li", { hasText: name });
  const menu = async (name: string, item: string) => {
    await row(name).getByRole("button", { name: "Actions" }).click();
    await page.getByRole("button", { name: item }).click();
  };

  await upload(page, [text("alpha.txt", "a"), text("zeta.txt", "z")]);
  await page.getByRole("button", { name: "New folder" }).click();
  await page.locator("dialog[open] input").fill("Photos");
  await page.locator("dialog[open]").getByRole("button", { name: "Create", exact: true }).click();
  await expect(row("Photos")).toBeVisible();
  await expect(row("zeta.txt")).toBeVisible();
  // The finished uploads panel covers the bottom right corner of the list.
  await page.getByRole("button", { name: "Clear finished" }).click();

  // Right click opens the same actions at the pointer; Escape closes them.
  await row("alpha.txt").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("button", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // A starred file goes to the top, above folders, and the "Starred" filter shows only it
  // (starred here from the right-click menu).
  await row("zeta.txt").click({ button: "right" });
  await page.getByRole("menu").getByRole("button", { name: "Star" }).click();
  await expect(list.locator("li").first()).toContainText("zeta.txt");
  await page.getByRole("button", { name: "Starred" }).click();
  await expect(list.locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "All", exact: true }).click();

  // A new label on alpha.txt; its chip filters the list.
  await menu("alpha.txt", "Labels…");
  await page.getByRole("button", { name: "New label" }).click();
  await page.getByLabel("Label name").fill("Work");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("dialog[open]").getByRole("checkbox")).toBeChecked();
  await page.locator("dialog[open]").getByRole("button", { name: "Save" }).click();
  await expect(row("alpha.txt").locator('[title="Work"]')).toBeVisible();
  await page.getByRole("button", { name: "Work" }).click();
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list.locator("li")).toContainText("alpha.txt");
  await page.getByRole("button", { name: "All", exact: true }).click();

  // Right click on one of several selected items: the actions apply to all of them.
  await page.getByRole("checkbox", { name: "Select alpha.txt" }).click();
  await page.getByRole("checkbox", { name: "Select Photos" }).click();
  await row("alpha.txt").click({ button: "right" });
  const group = page.getByRole("menu");
  await expect(group.getByText("2 selected")).toBeVisible();
  await expect(group.getByRole("button", { name: "Download as ZIP" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await group.getByRole("button", { name: "Star" }).click();
  await expect(row("alpha.txt").locator("svg.lucide-star")).toBeVisible();
  await expect(row("Photos").locator("svg.lucide-star")).toBeVisible();
  await row("Photos").click({ button: "right" });
  await page.getByRole("menu").getByRole("button", { name: "Remove star" }).click();
  await expect(list.locator("svg.lucide-star")).toHaveCount(1);
  // On an item outside the selection, the menu is that item's own.
  await row("zeta.txt").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("button", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText("2 selected")).toHaveCount(0);

  // A folder's color and icon.
  await menu("Photos", "Color and icon…");
  await page.locator("dialog[open]").getByRole("button", { name: "#ef4444" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "camera" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Save" }).click();
  await expect(row("Photos").locator("svg.lucide-camera")).toHaveCSS("color", "rgb(239, 68, 68)");

  // The drive's icon and cover show on the drives page.
  await page.goto(`/drive/${tokenId}/settings`);
  await page.getByRole("button", { name: "camera" }).click();
  await page.getByRole("button", { name: "dots" }).click();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.goto("/drive");
  const card = page.locator(`a[href="/drive/${tokenId}"]`);
  await expect(card.locator("svg.lucide-camera")).toBeVisible();
  await expect(card.locator("[aria-hidden][style*='radial-gradient']")).toHaveCount(1);
  await page.screenshot({ path: "test-results/customization-drives.png" });

  // Ids the app doesn't know (set through the API, e.g. by a previous owner) fall back to
  // the defaults, including names every JS object has.
  const status = await page.evaluate(async (id) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("etherdisk.session."))!;
    const { token } = JSON.parse(localStorage.getItem(key)!);
    const r = await fetch(`http://localhost:8788/api/vaults/${id}/profile`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ icon: "constructor", cover: "constructor" }),
    });
    return r.status;
  }, tokenId);
  expect(status).toBe(200);
  await page.reload();
  await expect(card.locator("svg.lucide-hard-drive")).toBeVisible();

  // Labels and stars survive a reload (sealed prefs and metadata on the server).
  await page.goto(`/drive/${tokenId}`);
  // A navigation locks the drive unless "stay unlocked" is on: wait for either screen.
  const unlockHeading = page.getByRole("heading", { name: /^Unlock / });
  await expect(unlockHeading.or(page.getByRole("button", { name: "Upload" }))).toBeVisible();
  if (await unlockHeading.isVisible()) {
    await page.getByPlaceholder("Passphrase", { exact: true }).filter({ visible: true }).fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "Work" })).toBeVisible();
  await expect(list.locator("li").first()).toContainText("zeta.txt");
  await page.screenshot({ path: "test-results/customization-files.png", fullPage: true });
});
