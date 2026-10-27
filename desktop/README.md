# Etherdisk desktop app

An app for Windows, macOS and Linux built with [Tauri 2](https://v2.tauri.app): the site's pages (`web/`) are built statically into the app, and the window is the system's WebView (WebView2 on Windows). The encryption is the same as on the site: files are encrypted and decrypted inside the app, and the server sees only ciphertext.

How it differs from the site:

- **The pages' code ships inside the app.** A hacked or tampered web server can't hand the app other JavaScript: it only changes with a new version of the app.
- **Links to other sites** (Etherscan, wallets, documentation) open in the browser; the app shows only its own pages. WebView2 doesn't report links that open a new window (`target="_blank"`, `window.open`) to the app, so `src-tauri/src/links.js` turns them into plain navigations, which then go to the browser.
- **Files can be dropped on the window** to upload, as on the site.
- **"Upload to Etherdisk" in Explorer** (on files and folders; on Windows 11 under "Show more options") and **Etherdisk in "Send to"**: the app opens (or brings its window forward) and asks which drive to upload to; with a single drive it opens that one. A locked drive asks for its passphrase; once unlocked, the files and folders upload into the drive's open folder, as with drag and drop (asking if names are already taken).
- **A second launch** brings the open window forward; the window's size and position are remembered.
- **Sign-in only through WalletConnect** (a QR code, signing in the wallet on a phone): browser extensions such as MetaMask don't reach the built-in WebView.

## How it works

- The pages are served by the `app://` scheme handler (`src-tauri/src/main.rs`): `app://localhost` on macOS and Linux, `http://app.localhost` on Windows. The pages with a drive number and the share pages are built once, for `_` (`/drive/_`, `/s/_`), and served for any id; the page takes the id from its address (`web/src/lib/route-param.ts`).
- The CSP is the site's (`web/next.config.ts`): in the static export it sits in every page's `<meta>`, and the app repeats it as a response header.
- API requests go to `NEXT_PUBLIC_API_URL` from the app's origin, so the server must allow it in `CORS_ORIGINS`. Sign-in messages are made for the site (`NEXT_PUBLIC_SITE_URL` → the domain in the SIWE message matches the server's `SIWE_DOMAIN`), and share links point to the site too.

### Files from Explorer

The installer adds the menu items (`src-tauri/windows/hooks.nsh`, for the current user; removed with the app). Windows' "Share" menu is only for MSIX-packaged apps, so Etherdisk isn't there — it is in "Send to". Both start the app with `--upload <paths>`. A second launch hands the paths to the open window (`tauri-plugin-single-instance`). The app keeps the paths (`src-tauri/src/share.rs`); the page gets their list and reads each file in 8 MiB pieces into an ordinary `File` (`web/src/lib/shared-files.ts`), then uploads it with the same encryption as the site. Only files handed over this way can be read. For that, the app's page CSP allows Tauri's IPC (`ipc:`, `http://ipc.localhost`).

### Where the data lives

The app keeps its data (the WebView profile with the sign-in and settings, and the window state) in an `Etherdisk` folder: `%APPDATA%\Etherdisk` on Windows, `~/Library/Application Support/Etherdisk` on macOS, `~/.local/share/Etherdisk` on Linux (`src-tauri/src/dirs.rs`). Versions up to 1.2 used folders named after the bundle identifier (`app.etherdisk.desktop`); their data moves to the new folder on the first start. Uninstalling with "Delete the application data" removes the folder.

## Server and WalletConnect

- In `deploy/server.env`: `CORS_ORIGINS=https://etherdisk.app,http://app.localhost,app://localhost`, then `docker compose up -d server`.
- In the [Reown Dashboard](https://dashboard.reown.com), the WalletConnect project's allowed domains (if set) must include `app.localhost` and `localhost`, or the connect dialog won't open.

## Building

You need Rust, Node.js 24, `wasm-pack` (as for `web/`) and [Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/) (on Windows, WebView2, which Windows 10 and 11 already have).

```bash
cd desktop
cp .env.example .env     # API and site address, network, contract, RPC, WalletConnect
npm ci
npm run build            # the static export of web/ → web/out, then the installer
```

The Windows installer is `src-tauri/target/release/bundle/nsis/Etherdisk_<version>_x64-setup.exe` (installs for the current user, without administrator rights). Its template is Tauri's standard one with a few changes (`src-tauri/windows/installer.nsi`, marked "Etherdisk:"): when the same version is installed and "Uninstall" is chosen, it only uninstalls and quits instead of installing again, and "Delete the application data" also removes the `Etherdisk` data folder. When updating `@tauri-apps/cli`, compare the template with the new upstream one. On macOS and Linux the same command builds a `.dmg`, an `.AppImage` and a `.deb`.

Only the settings from `desktop/.env` (or the environment) go into the build: `web/.env.local` isn't used, so a local development setup can't leak into a release.

**Releases.** When a release is published in the public repository, the workflow `.github/workflows/release.yml` builds the installer from the tagged commit, records its provenance (a GitHub attestation) and attaches `Etherdisk-windows-x64-setup.exe` with its SHA-256 to the release; the release notes get how to check it (`gh attestation verify Etherdisk-windows-x64-setup.exe --repo Fitesip/etherdisk`). The site's "Download for Windows" button points to this file of the latest release. The version in `src-tauri/tauri.conf.json` must match the tag (without the date), and the repository needs the `WC_PROJECT_ID` variable — otherwise the workflow stops.

CI builds the Windows installer on every PR (the "Desktop app" job, artifact `etherdisk-windows`). WalletConnect works in it when the repository has the `WC_PROJECT_ID` variable (Settings → Secrets and variables → Actions → Variables).

## Development

The interface is easier to work on in the site (`cd web && npm run dev`). The app takes its pages from `web/out`, so after changes in `web/`:

```bash
npm run web              # rebuild the pages
npm run dev              # run the app (tauri dev)
```

Checks: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`.

## Limitations

- The installer isn't code-signed, so Windows SmartScreen warns on the first run. On macOS the app needs Apple's signing and notarization, or Gatekeeper won't open it.
- No automatic updates yet: a new version installs over the old one.
