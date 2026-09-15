/**
 * RoamLink pre-commit checks. Installed by scripts/hooks/install.mjs.
 *
 * Deliberately lightweight and dependency-free (RL-001):
 *  1. blocks staging of local `.env` files (only `.env.example` is committed);
 *  2. scans *added* diff content for common credential patterns (RL-LOCK-016:
 *     secrets must never be committed);
 *  3. lints staged TS/JS files with the ESLint config of the package that
 *     owns them (staged-files lint, no vendor hook framework).
 *
 * Exit code 1 blocks the commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message) {
  console.error(`[roamlink-pre-commit] BLOCKED: ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const stagedRaw = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT"]);
const staged = stagedRaw.length === 0 ? [] : stagedRaw.split("\0").filter((f) => f.length > 0);

if (staged.length === 0) {
  process.exit(0);
}

// --- 1. block local env files -------------------------------------------------
for (const file of staged) {
  const base = file.split("/").pop() ?? "";
  if (base.startsWith(".env") && base !== ".env.example") {
    fail(
      `staged file '${file}' looks like a local environment file. ` +
        "Only .env.example may be committed; unstage it with `git restore --staged`.",
    );
  }
}

// --- 2. secret scan on added lines ---------------------------------------------
const SECRET_PATTERNS = [
  // NOTE: prefixes are written as character classes (e.g. "ghp[_]") so the
  // detector source itself never contains literal credential-prefix strings.
  { name: "GitHub classic PAT", pattern: /\bghp[_][A-Za-z0-9]{36}\b/ },
  { name: "GitHub fine-grained PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "GitHub app/oauth token", pattern: /\bgh[oars][_][A-Za-z0-9]{36}\b/ },
  { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "private key header", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const diff = git(["diff", "--cached", "-U0", "--", ...staged]);
const addedLines = diff
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1));

for (const line of addedLines) {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(line)) {
      fail(
        `added content matches a known secret pattern (${name}). ` +
          "Secrets must never be committed (RL-LOCK-016). Move the value into your local .env and unstage.",
      );
    }
  }
}

// --- 3. staged-files lint -------------------------------------------------------
const LINTABLE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;
const lintableFiles = staged.filter((f) => LINTABLE.test(f) && existsSync(join(repoRoot, f)));

function owningPackage(file) {
  let dir = dirname(join(repoRoot, file));
  const root = repoRoot;
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === root || dir.length < root.length) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const byPackage = new Map();
for (const file of lintableFiles) {
  const pkg = owningPackage(file);
  if (pkg === null) continue; // root-level scripts are not covered by a package config
  const list = byPackage.get(pkg) ?? [];
  list.push(file);
  byPackage.set(pkg, list);
}

for (const [pkgDir, files] of byPackage) {
  // ESLint runs with cwd = the owning package (so it picks up that package's
  // flat config); file arguments must therefore be absolute.
  try {
    execFileSync("pnpm", ["-C", pkgDir, "exec", "eslint", ...files.map((f) => join(repoRoot, f))], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    fail(`ESLint reported problems in staged files owned by ${relative(repoRoot, pkgDir) || "."}${sep}`);
  }
}

process.exit(0);
