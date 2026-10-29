# Changelog

Versions: `MAJOR.FEATURE.FIX.YYYYMMDD`
- **MAJOR** — a big release (counted from 0);
- **FEATURE** — smaller updates; when enough of them pile up, or one turns out large, the next release bumps MAJOR;
- **FIX** — fixes, and since 1.2.1 also each single new feature or improvement of an existing one (a release for each);
- **YYYYMMDD** — the date of the release commit.

## Unreleased

### Added
- **A new Etherdisk contract** (to be deployed to mainnet in place of the current one, which has no users yet):
  - **Metadata from a replaceable renderer.** The picture and the metadata are built by a separate contract, `EtherdiskRenderer`. The owner can replace it (`setRenderer`) to fix the picture or the texts without moving the tokens, until `freezeMetadata()` makes the metadata final for good. Marketplaces are told to refresh the cards (ERC-4906 `BatchMetadataUpdate`).
  - **Tiers with colors and a hidden flag.** Each tier has its own color (the drive picture and the site), set at creation; `setTierColor` recolors a tier and refreshes its cards (not after the metadata is frozen). `setTierHidden` takes a tier off the site's lists without touching its drives; the owner or an operator. A new tier (`addTier(capacity, price, color)`) is not on sale until `setTierActive`. Prices change with `setTierPrice`, as before.
  - **Royalties (ERC-2981):** 5% of resales to the owner, read by marketplaces that honor the standard; `setRoyalty`, up to 10%.
  - **Metadata:** one trait, `Capacity` ("1 TB"), instead of three (`Capacity`, `Capacity (GB)` and `Tier`); `external_url` points to the drive's page (`etherdisk.app/nft/<id>`: for sale with or without its files); the description no longer says the files "travel with the token" — they come with it only if the seller hands over the drive key.
  - **Moving drives to later versions without losing data.** Every version takes the drives of the one before it: the holder sends the old drive to the new contract (`safeTransferFrom`, or `approve` + `migrate`) and gets the same number and capacity in the same transaction, paying only the network fee; the old token goes to the owner (the Safe). Files, the key, links and the recovery key stay. Drives move one version at a time (v1 → v2 → v3); new drives are numbered after every earlier one. No number is handed out twice: a new version neither mints nor takes moves until the previous one has stopped minting for good (`closeSales()`, irreversible). Moves are closed until the owner opens them (`setMigrationOpen`); `rescueMigration` completes a drive sent with a plain transfer. This contract is v1: it has no previous version (`legacy` is the zero address).
  - The deploy script deploys and checks both contracts (renderer, then Etherdisk) and verifies both on Etherscan; `mainnet-tiers.env` adds the tier colors, `ROYALTY_BPS` and `PAGE_BASE`.
- The site reads the tiers' colors and hidden flags from the contract: hidden tiers are left out of the mint and pricing lists, and drives everywhere take their tier's color.
- **Contract updates on the server and the site** (docs/MIGRATION.md): `LEGACY_CONTRACT_ADDRESS` lists every earlier contract, newest first. A drive that hasn't moved yet shows a notice with a **Move drive** button and stays read-only until it moves: its files open and download, but uploads, folders, renames, moves, deletion, links and settings are off (the server answers `409 old_contract`). Drive cards mark it "Needs moving".
- **The desktop app keeps its data in an `Etherdisk` folder** (`%APPDATA%\Etherdisk` on Windows, `~/Library/Application Support/Etherdisk` on macOS) instead of folders named after the bundle identifier (`app.etherdisk.desktop`). The data of earlier versions (the sign-in and settings, the window's position) moves there on the first start; uninstalling with "Delete the application data" removes the new folder too.

### Changed
- Everything is in English: `CHANGELOG.md`, the release notes, the documentation (`docs/`, `deploy/README.md`, `desktop/README.md`) and the server's Telegram alerts and `/status`.

## 1.2.2.20261025

### Added
- **Selling a drive.** The drive settings have a "Sale" section: the owner puts the drive up for sale "with the files" (promising to hand the key to the buyer; after the NFT changes hands the app asks them to) or "without the files" (the key isn't handed over and the buyer formats the drive; nobody asks for the key after the transfer). While the drive is for sale, its public page `/nft/<id>` (no wallet needed) says so and shows how much of it is used; the drive list marks it "For sale". Any transfer of the NFT ends the sale; the server doesn't show a former owner's listing even before the indexer sees the transfer. The NFT and its picture don't change: on a marketplace, link the page from the listing or the collection description. API: `PUT`/`DELETE /api/vaults/{id}/sale`, public `GET /api/nft/{id}`, `sale` on the drive; migration `0016`.

## 1.2.1.20261022

### Added
- **"Upload to Etherdisk" in Explorer's menu and Etherdisk in "Send to"** (desktop app): the selected files and folders go to the app, which asks which drive (when there are several), opens it — asking for the passphrase if it is locked — and uploads them into the open folder, as with drag and drop. On Windows 11 the items are under "Show more options".
- **A "Download for Windows" button** on the site's home page (not inside the app): the installer of the latest release. GitHub Actions builds it from the tagged commit when a release is published and attaches it with its SHA-256 and a build provenance attestation (`gh attestation verify Etherdisk-windows-x64-setup.exe --repo Fitesip/etherdisk`).

### Fixed
- Windows installer: when the same version is already installed and "Uninstall" is chosen, it only uninstalls the app instead of installing it again.

## 1.2.0.20261020

### Added
- **Desktop app** (`desktop/`, Tauri 2): Windows, macOS and Linux. The site's pages are built statically into the app, so a tampered web server can't serve it other code; the encryption is the same as on the site. Links to other sites (including those that open a new window) open in the browser, files can be dropped on the window to upload, a second launch brings the open window forward, and the window's size and position are remembered. Sign-in goes through WalletConnect. The Windows installer (NSIS, no administrator rights) is built in CI on every PR. Building, settings and limitations: `desktop/README.md`.
- **A static export of the site** (`NEXT_OUTPUT=export`) for the app: the pages with a drive number or a share id are built once and served for any id, and the CSP is in the pages' `<meta>`. `NEXT_PUBLIC_SITE_URL` is the site's address that sign-in messages are made for and share links point to (empty: the page's own address, as before).

### Changed
- The PWA manifest is a static file, `public/manifest.webmanifest` (same address).
- In the `deploy/server.env` example, `CORS_ORIGINS` allows the app's origins (`http://app.localhost`, `app://localhost`).

## 1.1.0.20261016

### Added
- **Disk space reserved for every drive sold** on its physical volume: its unused capacity is held as real used space (a `.reserve` file in the drive's folder, `fallocate`). A mint reserves the whole capacity; an upload takes its size from the reservation, and deleting or formatting gives it back. Writing to a bought drive can no longer hit a full volume, and "free" on a volume now means "not sold to anyone yet". A new drive goes to a volume with room for its whole capacity; the reservation never takes a volume's last 5%. When there is no room left to reserve, Telegram gets an alert with the drive numbers, and `/status` shows how much is reserved. The server sets up the reservation of drives bought earlier when it starts. `RESERVE_SPACE=false` turns it off on a developer's machine.
- **A drive that found no room stores only what is reserved for it.** Its uploads take space from its own reservation and never touch a volume's last 5% (the system, the database); beyond what is available, an upload gets "storage_short" (the site says the service is temporarily short of storage and the files are safe). With no room at all, the drive has 0 bytes. The site shows the bought capacity struck through next to the usable one (in the drive list, the drive's header, the usage bar and the settings) and explains why; the full capacity comes back by itself once storage grows. API: `usable_bytes` on the drive. The reservation is also set up on the drive's first use, without waiting for the indexer. The monitor rechecks short drives on every round: space freed on their volume becomes theirs without a restart or a visit from the owner. When their volume has no room but another one (say, a new array) fits the whole capacity, the drive moves there by itself: its files are copied and renamed into place, the drive is switched over and the old copy is removed; uploads and deletes wait during the copy, and reads come from the old copy.
- **Telegram no longer loses alerts when a proxy dies.** `TELEGRAM_PROXY` takes several comma-separated proxies: when one doesn't answer (10 seconds to connect), the server moves on to the next and keeps using the one that works. Messages that couldn't be sent (Telegram or every proxy unreachable) wait in a queue (up to 50; older ones are dropped with a note of how many) and go out in order once Telegram answers again, marked "⏳ late by N min".
- **Adding RAID arrays without editing `docker-compose.yml`:** volumes are listed in `deploy/storage.yml` (example: `storage.yml.example`); step by step under "Adding storage" in `deploy/README.md` (mdadm, the file system, a protected mount point, permissions, `DATA_DIR`).

### Fixed
- `deploy/server.env` (with the bot token), `deploy/storage.yml`, certificates and data folders in `deploy/` are ignored by git: a careless `git add .` on the server won't push them.

## 1.0.0.20261016

### Added
- **The contract on Ethereum mainnet:** `0x15B87e1e71B48919CfD6fd23089642A1BA48aBf0`, block 26193612, owned by the Safe `0xBDcEBBc53331a741316E4faaCf4bfD99D63Ad449` (2 of 3). Tiers: 64 / 128 / 256 GB on sale, 512 GB / 1 TB / 2 TB "coming soon". The deploy cost 0.000430 ETH (0.139 gwei). The source is verified on Etherscan. The address and block are in `contracts/deployments/chain-1.json` and in the `deploy/` settings examples.
- **A new contract on Sepolia** (version 1.0, no token enumeration): owned by a Safe, the mainnet tiers at a tenth of the price. Server data: `data/v6`. The deploy took 20.5M gas on Sepolia (≈ 3.1M on mainnet under the old rules).
- **A configurable network:** `NEXT_PUBLIC_CHAIN_ID` in the app (1 — Ethereum mainnet, 11155111 — Sepolia, the default) and `CHAIN_ID` on the server. The wallet (the network and switching to it), signing in, the CSP, Etherscan links and the texts follow it: on mainnet nothing mentions a testnet or a faucet, and prices read "in ETH plus the network fee". The config examples use mainnet RPCs (publicnode and tenderly: both serve `eth_getLogs` over 500 blocks; drpc, 1rpc, cloudflare and ankr don't suit the server).
- **Moving to a new contract without losing data** (`docs/MIGRATION.md`): the `EtherdiskMigration` module for a future contract — an owner swaps an old drive for a new one with the same number and capacity in one transfer (`safeTransferFrom` to the new contract) or with `approve` + `migrate`; the old token stays in the new contract for good, other NFTs are rejected, swapping is closed until the owner opens it, new drives are numbered after the old ones, and a drive stuck after a plain `transferFrom` is released by the owner by hand. A server with `LEGACY_CONTRACT_ADDRESS` works with both contracts: drives not swapped yet come from the old one, and a swap doesn't count as a change of owner (links, the key and votes stay); the database moves to the new contract by itself. The current contract needs nothing for this. Tests: 8 in Foundry, 2 on the server; the whole path was checked on anvil with the real server.
- **A mainnet deploy script,** `contracts/script/deploy-mainnet.sh`: checks the network and that the owner is a contract (the Safe), takes the gas estimate from the node, shows the fee and the balance, stops when the gas price is above `MAX_GWEI`, deploys from a keystore after confirmation (`forge create`, limit × 1.2), checks `name`, `owner` and every tier on chain, saves the address and block in `contracts/deployments/`, verifies on Etherscan and prints the settings for the server and the site. Tested on a local anvil. Estimate on 2026-10-15: 3,118,104 gas, ≈ 0.00047 ETH ($1.08) at 0.15 gwei.
- **A mainnet launch checklist** (`docs/LAUNCH.md`): a "2 of 3" Safe, the node's gas estimate and the deploy, checking the contract, Etherscan verification, operators, the server and site configs, checks after launch. Estimate on 2026-10-14: deploy ≈ 3.12M gas (≈ $11 at 1.5 gwei), mint ≈ 141k gas (≈ $0.49).
- **Docker deployment** (`deploy/`): images of the server (Rust, `debian:bookworm-slim`, an unprivileged user) and the site (Next.js standalone, the WASM built inside), a `docker-compose.yml` with nginx and certbot, the nginx config for etherdisk.app (HTTPS, HSTS, redirects from www and http, the API at `/api/` on the same domain, streamed uploads and downloads, `X-Forwarded-For` overwritten — the server uses its first address for rate limits —, container addresses resolved on every request), settings examples and the guide `deploy/README.md` (folder permissions, protecting mount points, the first certificate and renewals, updates, backing up the database). CI builds both images, runs `nginx -t` and starts the containers, checking that the site, the service worker, the WASM and the API answer.
- **Terms of service and privacy policy** (drafts, to be checked by a lawyer): the `/terms` and `/privacy` pages, links in the footer, and "by buying a drive you agree…" under the tiers. The texts are Markdown in `web/src/legal/`, editable without code; the site renders them at build time. On mainnet the footer doesn't say "Testnet prototype".
- **Running behind the host's nginx:** nginx's ports are set in `.env` (`HTTP_PORT`, `HTTPS_PORT`), and `behind-proxy.yml` switches to a mode where 80/443 and the certificate stay with the nginx already installed and the containers listen on `127.0.0.1:8880` only. An example config for the host's nginx: `deploy/nginx/host-etherdisk.conf`. CI checks both modes.
- **A proxy for Telegram** (`TELEGRAM_PROXY`): http, https, socks5 or socks5h, with or without a login; only requests to Telegram go through it. A wrong address stops the server from starting instead of silently turning alerts off; the proxy address never appears in errors or logs.
- **More ways to style drives:**
  - a drive's **icon** (22 to choose from) and the card's **cover** (dots, grid, stripes, waves, rings, glow, aurora — in a color of its own, by default the fill color, migration `0015`; the aurora's second color is the outline color; the card's usage bar has an outline and a solid background so it reads over the cover). Stored next to the name and colors, unencrypted (migration `0014`);
  - **a drive's default color matches its NFT**, by capacity: 64 GB indigo, 128 GB green, 256 GB yellow, 512 GB pink, 1 TB sky blue, 2 TB purple;
  - a folder's **color and icon** ("Color and icon…" menu);
  - **stars**: a star on a file or folder puts it first in the list;
  - **labels**: your own names and colors, dots next to file names, several labels per file, applied to all selected files at once;
  - a **filter** above the list: "Starred" and each label.
  Stars, labels and a folder's color and icon live in the files' encrypted metadata; the drive's list of labels lives in its encrypted settings (`GET/PUT /api/vaults/{id}/prefs`, AAD `etherdisk/prefs/{id}`, up to 64 KiB, deleted by a format). The server sees neither label names nor which files have them. Share links don't carry them. An e2e test covers all of this.
- Privacy policy: the data table lists the drive's icon and cover; the retention of the name and colors is corrected (they stay with the drive through a format and a change of owner instead of being deleted).
- **Files can be dropped anywhere on the page,** not only on the list: dragging over the window shows a full-window overlay (in the drive's colors, naming the folder the files go to); files upload into the open folder. Moving files within the drive doesn't trigger it.
- **A right-click menu** on files and folders with the same actions as the "…" button, at the pointer (it opens the other way near the edge of the screen). It closes on a click elsewhere, Escape or scrolling. Right-clicking one of several selected items acts on the whole selection: "Download as ZIP", star, labels, move, delete (as in Explorer).
- **A new logo and favicon:** a drive platter with a lit sector and the read arm (`design/logo/etherdisk-logo.svg`, variants next to it). It builds `favicon.ico` (16/32/48), `icon.svg`, the iOS icon and the app icons including maskable: `node design/logo/build-icons.mjs`. The header logo is the same mark.
- **Landing page:** a "Your drive is a real NFT" section with the token's picture as the contract draws it (the platter spins, the arm moves, the sizes cycle, the card tilts with the pointer); small drives on the tier cards (spinning on hover); the technologies in a marquee; pulsing step numbers. The app's mint cards have the same style: the drive picture (spinning on hover and while minting), the price per GB, a "Popular" badge on the tier bought most often (the server counts mints from `DriveMinted` events: table `tier_mints`, migration `0013`, public `GET /api/tiers/stats`; a database without it reads past events once at startup; no badge until something is bought; a tie goes to the smaller tier), a dashed border on "Coming soon"; while the tiers are read from the contract, shimmering placeholder cards stand in for them (in the app and on the landing page). The footer shows the year. The "End-to-end encrypted · on Ethereum" badge and the "Live on Ethereum" line are gone.
- **nginx doesn't log IP addresses:** its own log format without the client address, and the error log keeps critical errors only.

### Changed
- **Minting and transferring drives costs a third less.** The contract no longer enumerates tokens per owner (`ERC721Enumerable`), which wrote extra storage on every mint and transfer. Mint: 212,615 → 140,958 gas, transfer: 90,785 → 59,921, deploy: −7%, code: 12.8 → 11.7 KB. `totalSupply` stays (a simple counter); `tokensOfOwner` is gone.
- **The server keeps wallets' drive lists** from `Transfer` events (table `token_owners`, migration `0012`); a database without it reads past events once at startup. Every listed drive is checked with `ownerOf`, so a lagging indexer can hide a new drive for a moment but never show someone else's. A drive just bought shows up within seconds without a reload: the site takes its number from the receipt and asks the server to confirm it every 3 seconds (`ownerOf`; the server's RPC node may not see the new token yet), showing an animated "Drive #N — setting up" card meanwhile. "Drive minted" hides after 5 seconds. Access is still decided by `ownerOf`.

### Fixed
- **WalletConnect:** the modal is no longer empty — the CSP allows the wallet list and its icons (`api.web3modal.org`), the modal's font (`fonts.reown.com`) and its frames. Signing in no longer fails silently: a rejected signature or a failed sign-in is reported, and while waiting for the signature over WalletConnect the site suggests opening the wallet app (on a phone it opens it). The wallet shows Etherdisk's icon next to the requests.
- **Picking a volume for a new drive** no longer depends on random swings of free space: a difference under 1 GB counts as a tie, which goes to the volume with fewer drives. Before, with a single disk (or one others write to at the same time), a new drive could go to the wrong volume, which made a CI test fail.
- The settings examples (`crates/etherdisk-server/.env.example`, `web/.env.example`, `contracts/.env.example`) and `docker-compose.yml` default to mainnet: network 1, the contract's address and block, mainnet RPCs, 3 confirmations; Sepolia is in comments.
- **An unknown icon or cover id no longer breaks the page.** An id like `constructor` (the server accepts it, and every JavaScript object has it) could break the next owner's drive list, and a folder icon the file list. Only ids from the app's sets are used now, anything else falls back to the default; an e2e check.
- **Tailwind classes no longer conflict:** `cn` resolves conflicts with `tailwind-merge` (the later class wins). The "Popular" card got its own border and the chosen icon in the icon picker its color.
- **Labels are no longer wiped:** the labels dialog opens only once the drive's labels are loaded (a spinner meanwhile, "Retry" on an error); otherwise saving an empty list would have erased them all.
- **After a format** the site drops the drive's labels and files from its cache at once instead of showing (and saving back) the old ones.
- **A former owner can no longer "take back" a drive in the lists:** opening a drive records its holder only when the server doesn't know one yet; only the indexer changes a known holder. A drive bought shows up in the new owner's list once the indexer sees the transfer (one polling round plus the confirmations). A test.
- **The indexer no longer gets stuck reading history:** after 10 failed attempts (say, the RPC node doesn't serve old events) it moves on to new blocks — transfers keep revoking links and access — and logs an error; it tries the history again on the next start.
- **The "setting up" card no longer waits forever:** when the drive belongs to another wallet (bought from a different one than signed in) or isn't confirmed within 10 minutes, it stops waiting.
- **Saving a drive's profile no longer resets fields the request leaves out** (a tab running an older version of the site won't clear the icon and cover); `null` still resets. A test.
- A star, labels and a folder's look change the metadata read back from the server, not the list's copy: a rename made in another tab isn't undone.
- The aurora cover without an outline color uses the drive's color, not pink.
- `docs/CRYPTO.md`: "what the server sees" lists the icon, the cover and its color, the encrypted settings, the holder and the tier.

## 0.5.0.20260921

### Added
- **A new contract on Sepolia** (version 0.5: tiers from the constructor, operators, two-step ownership, a new picture): owned by a Safe, the mainnet tiers (64 GB – 2 TB) at a tenth of the price, 512 GB – 2 TB "coming soon". Server data: `data/v5`. The deploy costs ~22.3M gas.
- **Recovery key:** 24 words (BIP-39, 256 bits) that open a drive when its passphrase is forgotten. They only work together with the wallet that owns the drive.
  - Created inside the drive (a "Create recovery key" banner that can be dismissed) or in the drive settings, where it can also be replaced (the old words stop working) or deleted.
  - The words can be downloaded as a text file or printed: a sheet with numbered words, a QR code, the drive's details and instructions. Before saving, the app asks for three random words from the copy. Until the key is saved, the words stay in the page's memory: reopening the dialog shows the same words, so a downloaded file stays valid. If the words were downloaded or printed, closing the dialog warns that they don't work yet.
  - The unlock screen has "Forgot the passphrase? Use your recovery key": enter the words (case, numbering, punctuation and shortening to the first four letters don't matter; a hint points at a wrong word) and set a new passphrase. The recovery key keeps working afterwards.
  - How it works: HKDF turns the words into a key that wraps the drive key (XChaCha20-Poly1305); the server keeps only this wrapping (77 bytes) and can't open it. A transfer of the drive deletes former owners' keys, and so does a format.
  - Server: `GET|PUT|DELETE /vaults/{id}/recovery`, `recovery_at` on the drive, migration `0009_vault_recovery`. Crypto crate: module `recovery`, `Vault::wrap_for_recovery`, `Vault::recover`.
- **Fallback RPCs.** The server's `RPC_URL` and the app's `NEXT_PUBLIC_RPC_URL` take several comma-separated addresses. The server ranks nodes by reliability and speed, asks one at a time and moves to the next on failure; "too many requests" answers are retried after a pause. The app tries the addresses in order. The config examples add a fallback Sepolia node (tenderly): only nodes that serve `eth_getLogs` over `LOG_BLOCK_RANGE` blocks suit the server, because an error answer doesn't switch to the fallback.
- **Several storage places (volumes).** `DATA_DIR` takes several comma-separated folders, say one per RAID array. Each drive NFT is stored whole in one folder; a new drive goes where there is the most free space (a tie goes to fewer drives). A folder is marked with a `.etherdisk-volume` file holding its id, and which drive is where is kept in the database, so the order and paths of folders in the config can change. When a folder is taken out of the config or its array isn't mounted, its drives answer with an error instead of starting afresh elsewhere. An existing data folder becomes a volume on the first start and keeps its drives. At startup the server logs each volume's free space. Migration `0010_vault_volumes`.
- **Monitoring with Telegram alerts.** Every minute the server checks the free space of each volume and of the database (a warning below 15%, an alert below 5%), unavailable volumes, the indexer lagging behind the chain, RPC availability and bursts of 5xx errors. The chat gets one message when a problem appears, a reminder every 6 hours while it lasts and a message when it is gone; a summary at startup. `/status` in the chat answers with the current state (the bot answers only in the configured chat). Settings: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, the `ALERT_*` thresholds, `MONITOR_INTERVAL_SECS`; without a token alerts go to the log only. The token never reaches the logs. Volumes and the database on one disk give one message about space, not several.
- **Ideas board moderators in the config** (`IDEAS_ADMINS`, comma-separated addresses) besides the contract owner. Needed when the contract belongs to a multisig (Safe), which can't sign in: moderators use their own wallets.
- **Checked with a multisig:** a mainnet fork test deploys the contract with a real Safe 1.4.1 as the owner and confirms that mint payments reach it within the payout gas limit (`MAINNET_RPC_URL=… forge test --match-contract Safe`; skipped without the variable).
- **Contract review:** invariant tests (Foundry randomly mints, transfers, changes prices and tiers, withdraws and changes the owner, including to one that rejects ETH) check that no money is lost, a drive's capacity never changes after minting and the number of drives adds up. CI runs the static analyzers Slither (high findings fail the build) and Aderyn (its report is a build artifact).
- **A cryptography spec for auditors** (`docs/CRYPTO.md`): keys and their hierarchy, blob and file formats, metadata, links and their passwords, key handover through the inbox, the recovery key, what the server sees, browser assumptions, known limitations and questions for the auditor.
- **A new drive key for a new owner.** The former owner knew the drive key, so on receiving a drive (with the passphrase, the recovery key or a key handover) the new owner sets their own passphrase right away and the drive gets a new key. Anything they add can't be read by the former owner even if the server's data leaks. Files that came with the drive stay readable: the old keys are kept in a "keyring" encrypted with the new key. Each file's metadata records which key it uses. Recovery keys of the old key are deleted. Server: `keyring`, `needs_new_key` in the key response, `rotate` when replacing it; migration `0011_key_rotation`. Crypto crate: `Vault::rotate`, `seal_keyring`/`open_keyring`, `key_id`, `file_key_for`.
- **A new NFT picture:** an opened hard drive — a strip in the tier color with "ETHERDISK" and the number, a graphite platter with tracks, the capacity on the hub, a short read arm. The color follows the power of two of the capacity, so the six mainnet tiers (64 GB … 2 TB) get six different colors; bigger drives get more tracks. Mockups and variants: `design/nft/`.
- **Tiers set at deploy time** (capacities, prices, which are on sale right away) instead of the built-in 1/2/4 GB: for mainnet, 64, 128 and 256 GB on sale and 512 GB, 1 TB and 2 TB off for now. The deploy script takes them from `TIER_CAPACITIES_GB`, `TIER_PRICES_WEI`, `TIER_ACTIVE` and the owner from `OWNER`. The mainnet prices are agreed and recorded in `contracts/mainnet-tiers.env`: 64 GB — 0.005 ETH, 128 GB — 0.01, 256 GB — 0.02, 512 GB — 0.035, 1 TB — 0.065, 2 TB — 0.115 (at $2300 per ETH; storage costs 6.6–9.9 ₽ per GB over 10 years depending on the disks and RAID).
- **Contract operators:** the owner (`setOperator`) names wallets that open and close a tier's sales (`setTierActive`) without a multisig signature. Prices, new tiers and money stay with the owner.
- **"Coming soon":** tiers that are off show on the landing page and in the drive list with this label and no buy button. Capacities from 1024 GB read "1 TB", "2 TB".

### Changed
- **Contract: ownership moves in two steps** (`Ownable2Step`): the new owner has to accept (`acceptOwnership`), so a typo in the address breaks nothing. **`renounceOwnership` is disabled:** without an owner prices could never change and held payments couldn't be withdrawn. Takes effect with a new deploy. From the findings of Slither, Aderyn and Foundry's linter: `withdraw` rejects the zero address; the payout to the owner doesn't copy the receiver's answer (no "return bomb"); `DriveMinted` is emitted before the NFT receiver's callback, so re-entering can't reorder events; needless overrides are gone; the compiler version is pinned (`0.8.28`). The other findings were reviewed: deliberate choices (admin functions with the owner, low-level calls) or false positives.

### Fixed
- **A weak wrapping of a new passphrase because of the server.** When recovering with the words and when receiving the key from a former owner, the Argon2 parameters for the new passphrase came from the blob the server sent, unchecked. A malicious server could slip in negligible parameters and then crack the new passphrase offline. A new wrapping is now never weaker than the defaults (64 MiB, 3 passes). Found while writing the spec.

## 0.4.0.20260908

### Added
- **The NFT's picture and metadata inside the contract:** `tokenURI` returns JSON with the name "Etherdisk #N", a description, an SVG picture of the drive (its color depends on the capacity, "1 TB" from 1024 GB) and the Capacity and Tier attributes. Wallets and marketplaces show the drive without any outside server.
- **A new contract on Sepolia:** `Etherdisk`. Drives on the former contracts stay there, but the app works with the new one; the server keeps its data separately (`data/v4`). The deploy costs about 19.8M gas: Sepolia now charges more for storing code than Foundry 1.8.5 models, so `forge script` underestimates the limit — deploy with `forge create` and an explicit `--gas-limit` (about 22M).
- **CI on GitHub Actions** for every PR and push to `master`: clippy with `-D warnings` and the Rust tests, building (with the size check) and testing the contract in Foundry, building the WASM, linting, type-checking and building the frontend.
- **Guard against a contract change:** the server remembers which contract and network its database belongs to and won't start with another `CONTRACT_ADDRESS`. Otherwise a new token #1 would get the files and key of the old #1. An existing database binds to the current contract on its first start.
- **Trash:** deleting moves files and folders to the trash, with "Undo" in the notice. In the trash an item can be restored (into the root if its folder is in the trash too), deleted for good, or the trash emptied. Items are deleted automatically after 30 days. While in the trash, an item doesn't open through links or a folder address, and nothing can be created in it.
- **Search across the whole drive:** names are encrypted, so the index is decrypted in the browser. Search ignores case and diacritics, and the words can come in any order. Each result shows the folder it is in.
- **Selecting several items:** checkboxes in the list and the grid, "select all", and an action bar: download as ZIP, move, delete.
- **Downloading folders and selections as one ZIP:** the archive is streamed in the service worker without compression, with UTF-8 names and ZIP64 for large sizes, and its exact size is known in advance, so the browser shows progress. A folder link's page has "Download as ZIP".
- **A grid view** with large previews (the choice is remembered) and **a gallery** in the viewer: arrows on screen and on the keyboard, a "3 of 12" counter.
- **Link options:**
  - expiry (1, 7 or 30 days), enforced by the server;
  - a password: the manifest key is derived from the link key and the password with PBKDF2 at 600,000 iterations, so without the password the link opens nothing, and the server never sees the password;
  - a "view only" mode that hides the download buttons.

  The link list marks these options with icons.
- **Resuming interrupted uploads:** an unfinished upload stays on the server, and the drive offers "Select files". The chosen file is matched by name, size and date, then the last received chunk is encrypted again and compared with the server: only the same file can continue. The preview is made again with a fresh nonce.
- **Handing a drive's key to its new owner.** The drive key itself is handed over, not the passphrase: the sender doesn't reveal theirs, and the recipient sets their own, after which the old one stops working.
  - **Receiving drives** is turned on with one button: the wallet signs two free messages. The first signature derives an X25519 key in the browser, the second binds its public half to the address. The sender checks that signature themselves, so the server can't substitute the recipient's key.
  - **Transfers in the app:** the transfer dialog has a "send the drive key to the recipient" checkbox. The key is sealed for the recipient before the transaction.
  - **Transfers outside the app** (a wallet, a marketplace): the indexer notices the transfer and creates a request. The former owner sees "Drives waiting for their key" on the drives page, enters their passphrase and sends the key (or declines). The wrapped key is only handed to them while the new owner hasn't changed the passphrase.
  - **The new owner** sees "The previous owner sent you the key" on the locked drive: they open it with the wallet and set their own passphrase right away. The passphrase form then hides behind "Enter passphrase instead". Until the key arrives, they see whom it is expected from and can turn receiving on.
  - The server only sees sealed data. New: `PUT /inbox`, `GET /inbox/{address}`, `GET|POST|DELETE /vaults/{id}/handover`, `GET /handovers/outgoing`, `DELETE /handovers/outgoing/{id}` and migration `0005_handover`. Crypto crate: module `inbox` (X25519 + HKDF + XChaCha20-Poly1305).
- Toast notifications.
- **An ideas board with voting** (`/ideas`): the owner of any drive proposes an idea, NFT holders vote for or against, one drive — one vote. Ideas are sorted by score (for minus against). Authors can't vote on their own ideas. Every vote is signed by the wallet and kept on the server with its signature (as in Snapshot); a vote can be switched or withdrawn. Transferring a drive clears its votes: the new owner decides afresh (votes left by former owners are deleted at startup). Signatures are open for checking (`GET /ideas/{id}/votes`). The contract owner moderates: sets a status (open, planned, in progress, done, declined) and hides ideas. Migrations `0006_ideas`, `0008_idea_vote_choice` (authors' votes on their own ideas cast before it are deleted).
- **Rate limiting** on the server (a token bucket per IP): sign-in, public pages, the rest of the API, new ideas and votes each have their own limits. The answer is `429` with `Retry-After`. Behind a proxy the address comes from `X-Forwarded-For` when `TRUST_PROXY=true`.
- **XSS protection:** a Content-Security-Policy for the app (own scripts only, network requests only to the API, the RPC and WalletConnect, no frames or `object`), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. The service worker serves decrypted files with a `sandbox` CSP, and only safe types open in the browser (images, video, audio, PDF, text as `text/plain`); the rest are downloaded. The API answers with the CSP `default-src 'none'; sandbox`.
- **Argon2 in a web worker:** creating a drive, unlocking it and changing the passphrase no longer freeze the page.
- **Easier work with files:**
  - sorting by name, size and date (buttons in the list headers and a menu; the choice is remembered);
  - dragging files and folders into a folder or onto the breadcrumbs;
  - on a name clash, "Replace", "Keep both" or "Skip";
  - shortcuts: Delete — to the trash, Ctrl/Cmd+A — select all, Esc — clear the selection, `/` — search, F2 — rename, Enter — open.
- **Mobile layout and PWA:** a manifest and icons, the app installs to the home screen; insets for the notch and gestures; on a phone the upload menu has "Take a photo or video"; a compact header.
- **E2E tests** (Playwright) against anvil, the real server and the built app: tiers on the landing page; upload, a name clash, search, trash with undo, a password link; transferring a drive with its key; ideas and voting. Added to CI.
- Server: `GET /objects/all`, `GET /trash`, `POST /trash/empty`, `POST /objects/{id}/restore`, `DELETE /objects/{id}/permanent`, `GET /uploads`, `DELETE /files/{id}/thumbnail`; link expiry; migration `0004_trash_and_link_expiry`.
- Crypto crate: `FileEncryptor::resume` (`WasmFileEncryptor.resume` in WASM).

### Changed
- **Mint payments go straight to the contract owner** instead of piling up in the contract. If the owner changes (`transferOwnership`), payments go to the new one. If the payout fails (the owner is a contract that doesn't accept ETH) or there is no owner, the payment stays in the contract (event `PaymentHeld`) and is taken out with `withdraw`, as before. The payout gets at most 50,000 gas, so an owner contract can't make minting expensive.
- **The project is renamed Etherdisk** (it was NFT Vault). Site: etherdisk.app.
  - Contract: `Etherdisk` (was `VaultNFT`), token "Etherdisk", symbol `DISK`, drives named "Etherdisk #N" and "Etherdisk" on the picture. The `VaultMinted` event is renamed `DriveMinted`. The name and symbol live in the contract itself, so it has to be deployed again.
  - Crates: `etherdisk-crypto`, `etherdisk-crypto-wasm`, `etherdisk-server` (binary `etherdisk-server`); the default database `data/etherdisk.db`; for e2e, `ETHERDISK_SERVER_BIN`.
  - The texts the wallet signs (sign-in, the key inbox, votes) start with "Etherdisk". Because of that everyone's inbox key changes after the update, and receiving drives has to be turned on again.
  - Browser settings keys now start with `etherdisk.`: the view, sorting, auto-lock and hints reset, and you have to sign in again.
  - The encryption format labels are now `etherdisk/...` (they were `nft-vault/...`): file keys, metadata, links and the key inbox. **Files encrypted by the previous version no longer open;** on the new contract this doesn't matter, it starts from a clean database.
- "Transfer drive" and "Format drive" left the drive's quick menu; they stay only in its settings (the "Danger zone" section).
- Landing page: the two floating drives around the encryption animation are back, and the animation itself is about twice as fast.
- `DELETE /objects/{id}` now moves to the trash (unfinished uploads are deleted right away). The owner can read the bytes already received of an unfinished upload, which resuming needs for its check.
- An interrupted upload (network, lock, closed tab) is no longer deleted by the client but kept for resuming. Only one the server rejected is deleted.

### Fixed
- Transferring a drive in the app with "send the key" unchecked still created a key request: the indexer saw the transfer and took it for one made outside the app. After a while the sender got a "send the key" button and the recipient "waiting for the key". The app now tells the server about the choice (`POST /vaults/{id}/handover/skip`), and no request is created for that transfer. The checkbox can be unchecked for a locked drive too; while it is checked, sending the key is offered from the drives page. Migration `0007_handover_skips`.
- After a transfer from the settings page the drive list didn't open, and the notice showed several times.
- A file's action menu ("⋯") was clipped by the edge of a short list, and its items couldn't be clicked. The menu now always shows in full and opens upwards when there's no room below.
- A drive's new owner got "This drive belongs to another wallet" right after the transfer because of the owner cache. On a mismatch the server now rechecks the owner on chain, and the cache lives 10 seconds instead of 30.
- The uploads panel now always sits in the bottom-right corner of the window. Before, an animated block of the page made it "stick" to the file list. Added overall progress, per-file percentages and a "collapse" button.

## 0.3.0.20260819

### Added
- **The drive's "Files / Settings" tabs:** above the drive's content, its name, token number and capacity. The "Files" tab returns to the last open folder.
- **A drive settings page** (`/drive/{id}/settings`):
  - name and colors with a preview;
  - security: auto-lock, "keep unlocked on reload", changing the passphrase, a "lock now" button;
  - the list of links;
  - the token's details with an Etherscan link;
  - the danger zone.
- **Auto-lock** after 5, 15, 30 or 60 minutes without activity (15 by default) or never. Uploads and playing video/audio count as activity. It checks every 10 seconds and when returning to the tab.
- **"Keep unlocked on reload"** (off by default): until the tab closes, the drive key is kept in `sessionStorage`, encrypted only. The encryption key (AES-GCM) is created non-extractable and lives in IndexedDB. After a reload the drive opens without the passphrase, unless the auto-lock time is up or the passphrase was changed on another device.
- **Transferring a drive** from the drive menu and the settings' danger zone:
  - with `safeTransferFrom` in the wallet, to the chosen address;
  - the address is validated, with a warning for your own address or a smart contract's;
  - `TRANSFER` has to be typed to confirm;
  - once the transaction is confirmed, the drive locks and the drive list opens.
- **Our own "show/hide passphrase" button** in every passphrase field. Edge's built-in button, which didn't always show, is hidden.
- **Animations:** dialogs fade in and out over a blurred background, menus unfold, the uploads panel slides in, tabs and sections fade in. With "reduce motion" on in the system, animations are off.
- **A new landing page:**
  - a first screen animating the real upload: a file (a photo, a PDF and a video in turn) is cut into chunks, each chunk flips into ciphertext, the file name is encrypted after it, then the ciphertext "drops" onto the drive;
  - a "what you see and what the server sees" block;
  - a feature grid lit under the pointer;
  - steps with a line drawing itself;
  - tiers with the best value per gigabyte highlighted;
  - a final call to action;
  - sections appearing on scroll.
- Crypto crate: `Vault::export_dek` / `Vault::from_exported_dek` (`exportKey` / `fromExportedKey` in WASM) for restoring after a reload.

### Changed
- The drive menu: "Lock", "Drive settings", then in red "Transfer drive" and "Format drive". Renaming, colors and changing the passphrase moved to the settings.
- "Reset drive" is renamed "Format drive", and its dialog looks like a dangerous action.
- The root of the path in files is called "All files"; the drive's name is now in the heading.

### Fixed
- A server/client render mismatch (hydration mismatch) on pages that depend on the wallet: a spinner shows while the wallet reconnects.

## 0.2.0.20260818

### Added
- **Uploading whole folders:** "Upload folder" in the upload menu and dragging folders. The nested folder structure is recreated, empty folders included. The upload queue shows each file's path and a "done/total" counter.
- **The open folder in the page address** (`/drive/1?folder=…`): after a reload the drive opens in the same folder (after the passphrase), the browser's Back/Forward go through folders, and a folder link can be bookmarked. A link to a deleted folder shows a message with a link to the root.
- **Drive names:** a drive can be renamed (up to 64 characters); the name shows in the drive list, headings and paths.
- **Drive colors:** an outline and a fill color (10 presets, a custom color or the default) with a preview. The outline colors the drive card's and the file list's border; the fill colors the drive icon, the usage bars and every accent button inside the drive, dialogs included; the text color on buttons is picked automatically for contrast.
- Backend: `PUT /api/vaults/{id}/profile` (name and colors) and `GET /api/vaults/{id}/objects/{id}/path` (a folder's path, to restore navigation), migration `0002_vault_profiles`.

### Changed
- **Rules for a new passphrase:** at least 8 characters, a lowercase and an uppercase letter, a digit and a special character; the rules are checked off as you type. This applies to creating a drive and changing the passphrase; existing passphrases keep opening their drives.

### Notes
- A drive's name and colors are stored on the server in plain text (to show them in the list while the drive is locked) and stay with the token through a transfer and a reset.
- Each folder upload creates new folders even when a folder of that name already exists.

## 0.1.0.20260817

The first release: end-to-end encrypted cloud storage where each drive is an NFT. Runs on the Sepolia testnet.

### Smart contract `VaultNFT` (`contracts/`)
- ERC-721: each token is a separate drive.
- Capacity tiers with a price and an active flag; a token's capacity is fixed at mint and never changes.
- Minting for ETH; withdrawals and tier management for the contract owner only.
- Deployed on Sepolia. Tiers: 1 GB — 0.0005 ETH, 2 GB — 0.00075 ETH, 4 GB — 0.001 ETH.

### Encryption (`crates/vault-crypto`, `crates/vault-crypto-wasm`)
- The drive key is random and wrapped with a key derived from the passphrase (Argon2id). Changing the passphrase rewraps only the wrapping; files are untouched.
- Files are encrypted in 1 MiB chunks (XChaCha20-Poly1305), protected against reordering and truncation; each file has its own key.
- File names, types and sizes are kept in encrypted metadata bound to the object.
- A WebAssembly build for the browser and the service worker.

### Backend (`crates/vault-server`)
- axum + SQLite, files on a local disk behind the `BlobStore` interface.
- Sign-In with Ethereum (single-use nonce, domain and network checks), bearer sessions.
- A token's owner and capacity are read from the contract.
- A `Transfer` event indexer: a change of owner revokes the drive's links; the files and the wrapped key stay with the token.
- Uploads in parts with a quota reservation and rollback of a failed part, cleanup of abandoned uploads.
- Downloads with HTTP Range, separate encrypted previews.
- Public links to files and folders: the server keeps only an encrypted manifest.
- A full reset of a drive, with confirmation.

### Web app (`web/`)
- Next.js 16, light/dark/system theme, an English interface ready for more languages.
- A landing page with a description and the current tiers from the contract.
- Wallet connection (MetaMask and other browser wallets, WalletConnect with a projectId set), switching to Sepolia, signing in with a signature.
- The drive list with usage and status, minting new drives.
- Setting up a drive (with a warning that the passphrase can't be recovered), unlocking, changing the passphrase, resetting.
- A file manager: uploads by button and drag and drop with on-the-fly encryption, folders, renaming, moving, deleting, an upload queue.
- Previews of images and video, viewing images, video with seeking, audio, PDF and text; downloads with the original name and format. Streamed decryption through the service worker.
- Links to a file or folder (the key only in the `#` fragment), a list of links, revoking, the public page `/s/{id}`.

### Known limitations
- A folder link freezes its contents at the moment it is created.
- The open folder isn't reflected in the URL; whole folders can't be uploaded.
- Smart contract wallets (EIP-1271) aren't supported.
- Unlocking a drive blocks the interface for about a second.
