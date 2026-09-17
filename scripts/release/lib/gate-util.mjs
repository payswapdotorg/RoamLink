/**
 * Shared file-analysis helpers for the release gates (RL-080/RL-081).
 *
 * Everything here is synchronous, read-only, deterministic and network-free:
 * the gates MEASURE the repository, they never mutate it. The functions take
 * an explicit `repoRoot` so machinery tests can point them at fixture trees.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads a text file, returning null (not throwing) when absent. */
export function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Discovers every workspace package declared by the pnpm-workspace globs:
 * `{ dir, name, hasTest, hasLint, hasTypecheck }`, sorted by package name
 * (deterministic order independent of filesystem iteration order).
 */
export function discoverWorkspacePackages(repoRoot) {
  const workspaceText = readText(join(repoRoot, "pnpm-workspace.yaml"));
  const globs = workspaceText
    ? [...workspaceText.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    : ["apps/*", "packages/*", "services/*", "tests/*"];
  const packages = [];
  for (const glob of globs) {
    const base = glob.replace(/\/\*$/, "");
    const baseDir = join(repoRoot, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const manifest = readText(join(repoRoot, dir, "package.json"));
      if (manifest === null) continue;
      try {
        const parsed = JSON.parse(manifest);
        packages.push({
          dir,
          name: typeof parsed.name === "string" ? parsed.name : dir,
          hasTest: Boolean(parsed.scripts?.test),
          hasLint: Boolean(parsed.scripts?.lint),
          hasTypecheck: Boolean(parsed.scripts?.typecheck),
        });
      } catch {
        // Unparseable manifests are surfaced by lint/typecheck steps, not the gate walk.
      }
    }
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return packages;
}

/**
 * Parses a vitest textual summary into counts. Understands both shapes:
 *   "Test Files  16 passed (16)"            / "Tests  107 passed (107)"
 *   "Test Files  1 failed | 15 passed (16)" / "Tests  3 failed | 104 passed (107)"
 * Returns zeros when the runner printed no summary.
 */
export function parseVitestSummary(text) {
  const result = {
    testFiles: { passed: 0, failed: 0, total: 0 },
    tests: { passed: 0, failed: 0, total: 0 },
  };
  const fileLine = text.match(/^.*Test Files\s+(.+)$/m);
  const testLine = text.match(/^.*Tests\s+(.+)$/m);
  const parseCounts = (segment) => {
    const counts = { passed: 0, failed: 0, total: 0 };
    const total = segment.match(/\((\d+)\)/);
    if (total) counts.total = Number(total[1]);
    for (const part of segment.split("|")) {
      const failed = part.match(/(\d+)\s+failed/);
      const passed = part.match(/(\d+)\s+passed/);
      if (failed) counts.failed = Number(failed[1]);
      if (passed) counts.passed = Number(passed[1]);
    }
    return counts;
  };
  if (fileLine) result.testFiles = parseCounts(fileLine[1]);
  if (testLine) result.tests = parseCounts(testLine[1]);
  return result;
}

/**
 * Strips JS/TS line and block comments from source text (deterministic,
 * conservative: string contents are not interpreted, only comment spans are
 * removed). Used so "an assertion references X" means executable text, not a
 * comment.
 */
export function stripComments(source) {
  let out = "";
  let index = 0;
  let state = "code";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = "string";
        out += char;
        index += 1;
        continue;
      }
      out += char;
      index += 1;
    } else if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += "\n";
      }
      index += 1;
    } else if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      if (char === "\n") out += "\n";
      index += 1;
    } else {
      if (char === "\\") {
        out += char + (next ?? "");
        index += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") state = "code";
      out += char;
      index += 1;
    }
  }
  return out;
}

/**
 * Canonicalizes an SLO phrase from spec/architecture.md §11 into a slug:
 * lowercase alphanumerics with single dashes, e.g.
 * "time to usable connectivity" -> "time-to-usable-connectivity".
 */
export function sloSlug(phrase) {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parses spec/architecture.md §11 into the SLO list (lowercased phrases,
 * trailing punctuation stripped). Returns [] when the section is missing —
 * the caller turns that into a criterion failure, never a silent pass.
 */
export function parseSpecSlos(repoRoot) {
  const spec = readText(join(repoRoot, "spec", "architecture.md"));
  if (spec === null) return [];
  const section = spec.match(/^## 11\. SLOs\n([\s\S]*?)(?=\n## |(?![\s\S]))/m);
  if (section === null) return [];
  return section[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      line
        .slice(2)
        .replace(/[.;,]+$/, "")
        .trim()
        .toLowerCase(),
    )
    .filter((line) => line.length > 0);
}

/**
 * Parses spec/api.md's backticked `/v1/...` resource paths (deduped, sorted).
 */
export function parseSpecApiResources(repoRoot) {
  const spec = readText(join(repoRoot, "spec", "api.md"));
  if (spec === null) return [];
  return [...new Set(spec.match(/`\/v1\/[a-z-]+`/g) ?? [])]
    .map((token) => token.slice(1, -1))
    .sort();
}

/**
 * Extracts every "/v1/..." string literal from a TypeScript source file
 * (route-table sources). Deterministic textual extraction of the public
 * route surface.
 */
export function extractRouteLiterals(source) {
  return [...source.matchAll(/"(\/v1\/[a-z0-9{}./-]*)"/g)].map((match) => match[1]);
}

/**
 * Walks a directory tree collecting files matching a predicate; returns
 * repo-relative paths sorted for determinism.
 */
export function walkFiles(repoRoot, dir, predicate = () => true) {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  const collected = [];
  const recurse = (relativeDir) => {
    const entries = readdirSync(join(repoRoot, relativeDir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) recurse(relative);
      else if (predicate(relative)) collected.push(relative);
    }
  };
  recurse(dir);
  return collected;
}

/**
 * Extracts fenced ```bash code blocks from markdown text.
 * Each block is returned as an array of command lines (comments/blank lines
 * stripped).
 */
export function extractBashBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let inBlock = false;
  let current = [];
  for (const line of lines) {
    if (!inBlock && /^```bash\s*$/.test(line.trim())) {
      inBlock = true;
      current = [];
      continue;
    }
    if (inBlock && /^```\s*$/.test(line.trim())) {
      blocks.push(current);
      inBlock = false;
      continue;
    }
    if (inBlock) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) current.push(trimmed);
    }
  }
  return blocks.filter((block) => block.length > 0);
}

/**
 * Extracts "RL-074-F1"-style finding IDs plus "DEFECT-1"-style defect IDs
 * from a verification document. Deduped, sorted.
 */
export function extractFindingIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(/\bRL-07[45]-F\d+\b/g)) ids.add(match[0]);
  for (const match of text.matchAll(/\bDEFECT-\d+\b/g)) ids.add(`RL-073-${match[0]}`);
  return [...ids].sort();
}
