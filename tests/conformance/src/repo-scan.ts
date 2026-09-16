/**
 * Repository structural scanning for the RL-070 conformance suites.
 *
 * Small, dependency-free scanners over the WORKSPACE TREE (package
 * manifests + TypeScript sources). Every scanner takes an explicit
 * `root` directory and an optional OVERLAY of virtual files, so the same
 * code that proves the real tree green can also be handed a violating
 * fixture (tmpdir tree or virtual overlay) and prove it detects the
 * violation - the RL-LOCK-018 negative-proof discipline.
 *
 * Scanned here are STRUCTURAL locks only (imports, dependencies, declared
 * vocabularies in source text). Behavioral locks are proven by the
 * per-lock suites against the real package runtimes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** A virtual file merged into a scan (repo-relative POSIX-ish path). */
export interface VirtualFile {
  readonly path: string;
  readonly content: string;
}

/** One source file with its full text (repo-relative path). */
export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

const SCANNABLE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo"]);

function walkFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, files);
    } else if (SCANNABLE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Reads every scannable source file under `roots` (repo-relative dirs such
 * as "packages" or "apps") of `root`, then merges the `overlay` on top:
 * an overlay file REPLACES a real file at the same path (the mutation
 * semantics) or adds a new virtual file (the new-violating-file semantics).
 */
export function readSourceFiles(
  root: string,
  roots: readonly string[],
  overlay: readonly VirtualFile[] = [],
): SourceFile[] {
  const byPath = new Map<string, SourceFile>();
  for (const sub of roots) {
    for (const file of walkFiles(join(root, sub))) {
      byPath.set(normalizePath(relative(root, file)), {
        path: normalizePath(relative(root, file)),
        content: readFileSync(file, "utf8"),
      });
    }
  }
  for (const virtual of overlay) {
    byPath.set(normalizePath(virtual.path), {
      path: normalizePath(virtual.path),
      content: virtual.content,
    });
  }
  return [...byPath.values()];
}

/** Normalizes a path to forward slashes and strips any `root` prefix. */
function normalizePath(path: string): string {
  return path.split("\\").join("/").replace(/^\.\//, "");
}

/** True when `path` (repo-relative, forward slashes) starts with any prefix. */
export function pathStartsWith(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

// --------------------------------------------------------------------------------
// Import extraction
// --------------------------------------------------------------------------------

const IMPORT_PATTERNS: readonly RegExp[] = [
  /import\s+[^;]*?from\s*["']([^"']+)["']/g,
  /export\s+[^;]*?from\s*["']([^"']+)["']/g,
  /import\s+["']([^"']+)["']/g,
  /require\(\s*["']([^"']+)["']\s*\)/g,
  /import\(\s*["']([^"']+)["']\s*\)/g,
];

/** Every module specifier the file imports (deduplicated, order-insensitive). */
export function importedSpecifiers(file: SourceFile): readonly string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

export interface ImportFinding {
  readonly file: string;
  readonly imported: string;
}

/** Every import of `specifier` (exact or prefix) across the files. */
export function findImportsOf(files: readonly SourceFile[], specifier: string): readonly ImportFinding[] {
  const findings: ImportFinding[] = [];
  for (const file of files) {
    for (const imported of importedSpecifiers(file)) {
      if (imported === specifier || imported.startsWith(`${specifier}/`)) {
        findings.push({ file: file.path, imported });
      }
    }
  }
  return findings;
}

// --------------------------------------------------------------------------------
// Package manifests + the workspace dependency graph
// --------------------------------------------------------------------------------

/** The name field of a package.json, or null for malformed/unnammed files. */
export function manifestName(root: string, packageDir: string): string | null {
  const path = join(root, packageDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

export interface PackageManifest {
  readonly dir: string;
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
}

/** Reads one workspace package manifest (missing files yield null). */
export function readManifest(root: string, packageDir: string): PackageManifest | null {
  const path = join(root, packageDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const name = typeof parsed.name === "string" ? parsed.name : null;
    if (name === null) return null;
    const deps = Object.keys(parsed.dependencies ?? {});
    const devDeps = Object.keys(parsed.devDependencies ?? {});
    return { dir: normalizePath(packageDir), name, dependencies: deps, devDependencies: devDeps };
  } catch {
    return null;
  }
}

/** Lists the workspace package dirs (packages/* and apps/*). */
export function workspacePackageDirs(root: string): readonly string[] {
  const dirs: string[] = [];
  for (const group of ["packages", "apps"]) {
    const groupPath = join(root, group);
    if (!existsSync(groupPath)) continue;
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = `${group}/${entry.name}`;
      if (existsSync(join(root, dir, "package.json"))) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

/**
 * Reads every workspace manifest, then merges `overlay` on top: a virtual
 * `package.json` REPLACES the real manifest of the same package dir (the
 * mutation semantics used by the violation toggle).
 */
export function readWorkspaceManifests(
  root: string,
  overlay: readonly VirtualFile[] = [],
): readonly PackageManifest[] {
  const overridden = new Set(overlay.map((file) => dirnameOf(file.path)));
  const manifests: PackageManifest[] = [];
  for (const dir of workspacePackageDirs(root)) {
    if (overridden.has(dir)) continue;
    const manifest = readManifest(root, dir);
    if (manifest !== null) manifests.push(manifest);
  }
  for (const file of overlay) {
    if (!file.path.endsWith("package.json")) continue;
    const parsed = JSON.parse(file.content) as {
      name?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (typeof parsed.name !== "string") continue;
    manifests.push({
      dir: dirnameOf(file.path),
      name: parsed.name,
      dependencies: Object.keys(parsed.dependencies ?? {}),
      devDependencies: Object.keys(parsed.devDependencies ?? {}),
    });
  }
  return manifests;
}

/** The package dir of a repo-relative file path ("packages/x/package.json" -> "packages/x"). */
function dirnameOf(repoRelativePath: string): string {
  const segments = repoRelativePath.split("/");
  segments.pop();
  return segments.join("/");
}

/** The runtime @roamlink/* dependencies of a package (manifest `dependencies`). */
export function workspaceRuntimeDeps(manifest: PackageManifest): readonly string[] {
  return manifest.dependencies.filter((dep) => dep.startsWith("@roamlink/"));
}

// --------------------------------------------------------------------------------
// Shared violation vocabularies (structural)
// --------------------------------------------------------------------------------

/** The 13-state ADCOS v2 contract lifecycle vocabulary (the authority's). */
export const ADCOS_CONTRACT_STATES: readonly string[] = [
  "INTENT",
  "OFFER_SELECTED",
  "CONTRACT_ACTIVE",
  "EXECUTION_ACTIVE",
  "DELIVERY",
  "ASSURED",
  "USAGE_FINAL",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "DEGRADED",
  "TERMINATED",
  "EXPIRED",
  "FAILED",
];

const STATE_ALT = ADCOS_CONTRACT_STATES.join("|");

/**
 * A transition-map entry: an ADCOS state literal (quoted or bare) used as
 * an object key mapped to an array that itself carries >= 2 quoted ADCOS
 * state literals (the shape of a lifecycle transition table).
 */
const TRANSITION_MAP_PATTERN = new RegExp(
  `(?:"(${STATE_ALT})"\\s*:\\s*\\[|(?:^|[\\s,{])(${STATE_ALT})\\s*:\\s*\\[)[^\\]]*"(?:${STATE_ALT})"[^\\]]*"(?:${STATE_ALT})"`,
  "m",
);

/**
 * A state-array literal: an array initializer carrying >= 3 distinct ADCOS
 * state literals (the shape of a competing lifecycle vocabulary).
 */
const STATE_ARRAY_PATTERN = new RegExp(
  `=\\s*\\[(?:[^\\]]*"(?:${STATE_ALT})"){3,}[^\\]]*\\]`,
);

/** The roots whose files may legitimately define ADCOS lifecycle semantics. */
export const ADCOS_LIFECYCLE_OWNER_ROOTS: readonly string[] = ["packages/adcos", "tests"];

/** A competing-lifecycle definition found in a file. */
export interface CompetingLifecycleFinding {
  readonly file: string;
  readonly kind: "transition-map" | "state-array";
}

/**
 * Finds files OUTSIDE the owner roots that define ADCOS-lifecycle-shaped
 * state machines (RL-LOCK-001: RoamLink must not duplicate or supersede
 * ADCOS connectivity semantics). Incidental references (opaque payload
 * strings in tests) do not match: only array literals with >= 3 states or
 * state->array transition maps do.
 */
export function findCompetingLifecycleDefinitions(
  files: readonly SourceFile[],
  ownerRoots: readonly string[] = ADCOS_LIFECYCLE_OWNER_ROOTS,
): readonly CompetingLifecycleFinding[] {
  const findings: CompetingLifecycleFinding[] = [];
  for (const file of files) {
    if (pathStartsWith(file.path, ownerRoots)) continue;
    if (TRANSITION_MAP_PATTERN.test(file.content)) {
      findings.push({ file: file.path, kind: "transition-map" });
    } else if (STATE_ARRAY_PATTERN.test(file.content)) {
      findings.push({ file: file.path, kind: "state-array" });
    }
  }
  return findings;
}

// --------------------------------------------------------------------------------
// Provider-SDK / AI-SDK / secret-pattern scanners (structural)
// --------------------------------------------------------------------------------

/** Provider SDK module patterns that must never leak into core packages. */
export const PROVIDER_SDK_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { name: "stripe", pattern: /^(?:stripe|@stripe\/.*)$/ },
    { name: "twilio", pattern: /^(?:twilio|@twilio\/.*)$/ },
    { name: "vonage", pattern: /^(?:@vonage\/.*|@nexmo\/.*)$/ },
    { name: "braintree", pattern: /^(?:braintree|@braintree\/.*)$/ },
    { name: "plivo", pattern: /^plivo$/ },
    { name: "sinch", pattern: /^(?:@sinch\/.*|sinch)$/ },
    { name: "telnyx", pattern: /^(?:telnyx|@telnyx\/.*)$/ },
    { name: "messagebird", pattern: /^(?:@messagebird\/.*|messagebird)$/ },
    { name: "adyen", pattern: /^(?:@adyen\/.*|adyen-api-library)$/ },
  ]);

/** LLM/AI SDK module patterns (RL-LOCK-012 advisory-only supply chain). */
export const AI_SDK_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { name: "openai", pattern: /^(?:openai|@openai\/.*)$/ },
    { name: "anthropic", pattern: /^(?:@anthropic-ai\/.*|anthropic-.*)$/ },
    { name: "azure-openai", pattern: /^@azure\/openai$/ },
    { name: "google-generativeai", pattern: /^@google\/generativeai$/ },
    { name: "langchain", pattern: /^(?:langchain|@langchain\/.*)$/ },
    { name: "llamaindex", pattern: /^(?:llamaindex|@llamaindex\/.*)$/ },
    { name: "z-ai-web-dev-sdk", pattern: /^z-ai-web-dev-sdk$/ },
    { name: "ollama", pattern: /^(?:ollama|@ollama\/.*)$/ },
    { name: "huggingface", pattern: /^@huggingface\/.*$/ },
  ]);

export interface SdkFinding {
  readonly file: string;
  readonly sdk: string;
  readonly imported: string;
}

/** Finds imports matching one of the SDK patterns across the files. */
export function findSdkImports(
  files: readonly SourceFile[],
  patterns: readonly { readonly name: string; readonly pattern: RegExp }[],
): readonly SdkFinding[] {
  const findings: SdkFinding[] = [];
  for (const file of files) {
    for (const imported of importedSpecifiers(file)) {
      for (const candidate of patterns) {
        if (candidate.pattern.test(imported)) {
          findings.push({ file: file.path, sdk: candidate.name, imported });
        }
      }
    }
  }
  return findings;
}

/**
 * Credential patterns mirrored from scripts/hooks/pre-commit.mjs (RL-LOCK-016).
 * Prefixes are written as character classes so the detector source itself
 * never contains literal credential-prefix strings.
 */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { name: "GitHub classic PAT", pattern: /\bghp[_][A-Za-z0-9]{36}\b/ },
    { name: "GitHub fine-grained PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
    { name: "GitHub app/oauth token", pattern: /\bgh[oars][_][A-Za-z0-9]{36}\b/ },
    {
      name: "private key header",
      pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    },
    { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
    { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  ]);

export interface SecretFindingInSource {
  readonly file: string;
  readonly pattern: string;
}

/** Finds literal credential material in source file contents. */
export function findSecretLiterals(
  files: readonly SourceFile[],
): readonly SecretFindingInSource[] {
  const findings: SecretFindingInSource[] = [];
  for (const file of files) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(file.content)) {
        findings.push({ file: file.path, pattern: name });
      }
    }
  }
  return findings;
}
