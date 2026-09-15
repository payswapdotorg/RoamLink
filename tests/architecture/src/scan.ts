/**
 * Architecture conformance scanning (RL-LOCK-018: tests prove architecture).
 *
 * This module ports the forbidden-import check from
 * scripts/check-architecture.mjs into a runnable, testable form:
 * application modules must never import ADCOS internal implementation
 * modules (RL-LOCK-002 one integration boundary; AGENTS.md rule 5). Only
 * packages/adcos (the ADCOS integration boundary itself) is exempt.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface ForbiddenImportRule {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface ForbiddenImportViolation {
  readonly rule: string;
  readonly file: string;
}

const ADCOS_INTERNAL_IMPORT_RULES: readonly ForbiddenImportRule[] = [
  { name: "adc-os-path-import", pattern: /from\s+["'][^"']*adc-?os\/[^"']*["']/i },
  { name: "adcos-scope-import", pattern: /from\s+["'][^"']*@adcos\/[^"']*["']/i },
  { name: "adc-os-path-require", pattern: /require\(\s*["'][^"']*adc-?os\/[^"']*["']\s*\)/i },
  { name: "adcos-scope-require", pattern: /require\(\s*["'][^"']*@adcos\/[^"']*["']\s*\)/i },
  { name: "adc-os-dynamic-import", pattern: /import\(\s*["'][^"']*adc-?os\/[^"']*["']\s*\)/i },
  { name: "adcos-scope-dynamic-import", pattern: /import\(\s*["'][^"']*@adcos\/[^"']*["']\s*\)/i },
];

const SCANNED_ROOTS = ["apps", "packages", "services"] as const;

const ADCOS_BOUNDARY_PREFIX = "packages/adcos/";

const SCANNABLE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

const SKIPPED_SEGMENTS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

function walk(dir: string, rootDir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_SEGMENTS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, rootDir, files);
    } else if (SCANNABLE_EXTENSION.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Scans a single file for forbidden ADCOS internal imports. */
export function scanSourceFile(file: string, repoRelativePath: string): ForbiddenImportViolation[] {
  if (repoRelativePath.startsWith(ADCOS_BOUNDARY_PREFIX)) return [];
  const source = readFileSync(file, "utf8");
  const violations: ForbiddenImportViolation[] = [];
  for (const rule of ADCOS_INTERNAL_IMPORT_RULES) {
    if (rule.pattern.test(source)) {
      violations.push({ rule: rule.name, file: repoRelativePath });
    }
  }
  return violations;
}

/**
 * Scans the given roots (default: apps/, packages/, services/) of a
 * repository root for forbidden imports. Returns every violation found; an
 * empty array means the boundary is intact.
 */
export function scanRepository(repoRoot: string): ForbiddenImportViolation[] {
  const violations: ForbiddenImportViolation[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of walk(join(repoRoot, root), repoRoot)) {
      violations.push(...scanSourceFile(file, relative(repoRoot, file)));
    }
  }
  return violations;
}
