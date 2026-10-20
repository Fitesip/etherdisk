// Builds the site's pages for the app: a static export of web/ into web/out, with the
// settings from desktop/.env (or the environment) and nothing from web/.env*.
// Run by `tauri build` (beforeBuildCommand); by hand: npm run web.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const VARS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_CONTRACT_ADDRESS",
  "NEXT_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_WC_PROJECT_ID",
];
const REQUIRED = ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_CHAIN_ID", "NEXT_PUBLIC_CONTRACT_ADDRESS"];

const file = new URL("../.env", import.meta.url);
const fromFile = Object.fromEntries(
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]])
    : [],
);

// Every variable is set (empty if unknown): Next.js doesn't override what the
// environment already has, so web/.env.local can't fill the gaps.
const env = { ...process.env, NEXT_OUTPUT: "export" };
for (const k of VARS) env[k] = process.env[k] ?? fromFile[k] ?? "";
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`desktop: set ${missing.join(", ")} in desktop/.env (see desktop/.env.example)`);
  process.exit(1);
}

const web = new URL("../../web", import.meta.url);
const run = spawnSync("npm", ["run", "build"], { cwd: web, env, stdio: "inherit", shell: process.platform === "win32" });
process.exit(run.status ?? 1);
