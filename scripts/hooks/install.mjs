/**
 * Installs the RoamLink pre-commit hook into `.git/hooks/pre-commit`.
 *
 * Run automatically by `pnpm install` via the root `prepare` script.
 * Zero third-party dependencies (RL-001: no heavy vendor coupling).
 *
 * Behavior:
 *  - skips silently when no `.git` directory exists (e.g. CI checkouts);
 *  - never overwrites a hook it did not install (marker based);
 *  - warns when `core.hooksPath` redirects git away from `.git/hooks`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const gitDir = join(repoRoot, ".git");

function log(message) {
  console.log(`[roamlink-hooks] ${message}`);
}

if (!existsSync(gitDir) || !existsSync(join(gitDir, "HEAD"))) {
  log("no .git directory found (CI or plain export) - skipping hook install.");
  process.exit(0);
}

let hooksPath = ".git/hooks";
try {
  const configured = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (configured.length > 0) {
    log(
      `core.hooksPath is set to '${configured}'. RoamLink will not manage that location; ` +
        "make sure your pre-commit runs scripts/hooks/pre-commit.mjs.",
    );
    process.exit(0);
  }
} catch {
  // unset config key - fall through to the default hooks directory
}

const hooksDir = join(repoRoot, hooksPath);
mkdirSync(hooksDir, { recursive: true });
const hookPath = join(hooksDir, "pre-commit");
const MARKER = "# roamlink-managed-hook";

if (existsSync(hookPath)) {
  const existing = readFileSync(hookPath, "utf8");
  if (!existing.includes(MARKER)) {
    log(
      `${hookPath} already exists and was not installed by RoamLink - leaving it untouched. ` +
        "Add 'node scripts/hooks/pre-commit.mjs' to it manually if you want the RoamLink checks.",
    );
    process.exit(0);
  }
}

const hook = [
  "#!/bin/sh",
  MARKER,
  "# Installed by scripts/hooks/install.mjs (pnpm prepare). Do not edit.",
  "set -e",
  "cd \"$(git rev-parse --show-toplevel)\"",
  "exec node scripts/hooks/pre-commit.mjs",
  "",
].join("\n");

writeFileSync(hookPath, hook, { mode: 0o755 });
chmodSync(hookPath, 0o755);
log(`installed pre-commit hook at ${hookPath}`);
