import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-4 Worker B packages (RL-062 apps/mobile + RL-063 packages/enterprise)
 * must keep the frozen dependency direction and the no-authority-logic layout
 * lock (RL-LOCK-019, spec/repository-layout.md):
 *
 *  - apps/mobile is an EDGE AGENT surface, deliberately unlike apps/web and
 *    apps/admin (which consume only the application kit): it composes the
 *    Wave-3 edge packages (@roamlink/edge, @roamlink/edge-actions,
 *    @roamlink/edge-connector) plus the shared typed-UI core
 *    (@roamlink/app-kit) and @roamlink/contracts - and NOTHING else. It
 *    never imports a domain, integration, ADCOS or platform-authority
 *    package, and its sources never touch node builtins (hosts bind the
 *    platform seams - the app stays runtime-agnostic);
 *  - packages/enterprise owns the enterprise customer journey + public API
 *    surface and depends ONLY on @roamlink/contracts (foundation),
 *    @roamlink/secrets (the ONLY way key material enters),
 *    @roamlink/audit (security events) and @roamlink/edge-connector (the
 *    RL-044 closed vocabularies, used directly - never redefined). It never
 *    imports the application kit (apps consume it, not the reverse) and
 *    never a domain/integration/authority package;
 *  - the contract vocabularies that must MIRROR an owning package are
 *    drift-guarded: the customer-webhook source-aggregate vocabulary
 *    mirrors @roamlink/notifications' TransitionOrigin owner, and the
 *    enterprise mutation-stage mirror mirrors the app-kit owner
 *    (RL-LOCK-018: tests prove architecture).
 */

const MOBILE_APP = "apps/mobile" as const;
const ENTERPRISE = "packages/enterprise" as const;

/** Packages apps/mobile must NEVER import (authority owners + non-edge surfaces). */
const FORBIDDEN_FOR_MOBILE = [
  "@roamlink/adcos",
  "@roamlink/integration",
  "@roamlink/webhook-inbox",
  "@roamlink/projections",
  "@roamlink/reconciliation",
  "@roamlink/compat",
  "@roamlink/domain-experience",
  "@roamlink/domain-commerce",
  "@roamlink/commerce-connectivity",
  "@roamlink/notifications",
  "@roamlink/auth",
  "@roamlink/persistence",
  "@roamlink/intent-compiler",
  "@roamlink/observability",
  "@roamlink/audit",
  "@roamlink/secrets",
  "@roamlink/retention",
  "@roamlink/resilience",
  "@roamlink/enterprise",
] as const;

/** Packages packages/enterprise must NEVER import. */
const FORBIDDEN_FOR_ENTERPRISE = [
  "@roamlink/adcos",
  "@roamlink/integration",
  "@roamlink/webhook-inbox",
  "@roamlink/projections",
  "@roamlink/reconciliation",
  "@roamlink/compat",
  "@roamlink/domain-experience",
  "@roamlink/domain-commerce",
  "@roamlink/commerce-connectivity",
  "@roamlink/notifications",
  "@roamlink/auth",
  "@roamlink/persistence",
  "@roamlink/edge",
  "@roamlink/edge-actions",
  "@roamlink/intent-compiler",
  "@roamlink/observability",
  "@roamlink/resilience",
  "@roamlink/app-kit",
] as const;

/**
 * Packages packages/enterprise must never import in RUNTIME sources. Test
 * files may additionally use @roamlink/retention - the sanctioned
 * RL-LOCK-016 secret scanner other packages' persisted payloads are tested
 * against (it stays a devDependency, pinned by the manifest test).
 */
const FORBIDDEN_FOR_ENTERPRISE_SRC = [
  ...FORBIDDEN_FOR_ENTERPRISE,
  "@roamlink/retention",
] as const;

const ALLOWED_MOBILE_DEPS = [
  "@roamlink/app-kit",
  "@roamlink/contracts",
  "@roamlink/edge",
  "@roamlink/edge-actions",
  "@roamlink/edge-connector",
] as const;

const ALLOWED_ENTERPRISE_DEPS = [
  "@roamlink/audit",
  "@roamlink/contracts",
  "@roamlink/edge-connector",
  "@roamlink/secrets",
] as const;

function readManifest(packageDir: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(join(REPO_ROOT, packageDir, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
}

function sourceFiles(packageDir: string, sub: "src" | "test"): string[] {
  const root = join(REPO_ROOT, packageDir, sub);
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

function roamlinkImportsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["'](@roamlink\/[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function nodeImportsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["'](node:[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function vocabularyValues(file: string, name: string): string[] {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\] as const`));
  expect(match, `${file} must define ${name} as a const array`).not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((token) => token.trim().replace(/^["']|["']$/g, ""))
    .filter((token) => token.length > 0);
}

describe("Wave-4 Worker B package boundaries (RL-LOCK-019, no authority in apps)", () => {
  it("apps/mobile declares exactly the edge-agent dependency set (+ testkit dev)", () => {
    const manifest = readManifest(MOBILE_APP);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(
        roamlinkDeps.sort(),
        `${MOBILE_APP} ${field} must declare exactly the allowed set`,
      ).toEqual([...ALLOWED_MOBILE_DEPS].sort());
    }
    const devDeps = manifest["devDependencies"];
    if (devDeps !== undefined) {
      const roamlinkDevDeps = Object.keys(devDeps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDevDeps.sort()).toEqual(["@roamlink/testkit"]);
    }
  });

  it("packages/enterprise declares exactly contracts + secrets + audit + edge-connector (+ testkit/retention dev)", () => {
    const manifest = readManifest(ENTERPRISE);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(
        roamlinkDeps.sort(),
        `${ENTERPRISE} ${field} must declare exactly the allowed set`,
      ).toEqual([...ALLOWED_ENTERPRISE_DEPS].sort());
    }
    const devDeps = manifest["devDependencies"];
    if (devDeps !== undefined) {
      const roamlinkDevDeps = Object.keys(devDeps).filter((name) => name.startsWith("@roamlink/"));
      // retention is the sanctioned RL-LOCK-016 scanner used in no-leak tests.
      expect(roamlinkDevDeps.sort()).toEqual(["@roamlink/retention", "@roamlink/testkit"]);
    }
  });

  it("apps/mobile src imports only the allowed packages (no authority leaks)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MOBILE_APP, "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(ALLOWED_MOBILE_DEPS as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `apps/mobile boundary violations: ${offenders.join(", ")}`).toEqual([]);
  });

  it("packages/enterprise src imports only its allowed packages (incl. no app-kit)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ENTERPRISE, "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(ALLOWED_ENTERPRISE_DEPS as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `packages/enterprise boundary violations: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("neither package imports a forbidden authority package anywhere (src or test)", () => {
    const offenders: string[] = [];
    for (const packageDir of [MOBILE_APP, ENTERPRISE] as const) {
      const isEnterprise = packageDir === ENTERPRISE;
      const forbidden = isEnterprise ? FORBIDDEN_FOR_ENTERPRISE : FORBIDDEN_FOR_MOBILE;
      const forbiddenSrc = isEnterprise ? FORBIDDEN_FOR_ENTERPRISE_SRC : FORBIDDEN_FOR_MOBILE;
      for (const file of [...sourceFiles(packageDir, "src"), ...sourceFiles(packageDir, "test")]) {
        const applicable = file.includes(join(packageDir, "src"))
          ? (forbiddenSrc as readonly string[])
          : (forbidden as readonly string[]);
        for (const imported of roamlinkImportsOf(file)) {
          if (applicable.includes(imported)) {
            offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
          }
        }
      }
    }
    expect(offenders, `authority leaks: ${offenders.join(", ")}`).toEqual([]);
  });

  it("apps/mobile src never imports node builtins (the shell is runtime-agnostic; hosts bind seams)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MOBILE_APP, "src")) {
      for (const imported of nodeImportsOf(file)) {
        offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
      }
    }
    expect(offenders, `node builtin usage in app sources: ${offenders.join(", ")}`).toEqual([]);
  });

  it("neither package uses dynamic imports to reach ADCOS internals", () => {
    const offenders: string[] = [];
    for (const packageDir of [MOBILE_APP, ENTERPRISE] as const) {
      for (const file of [...sourceFiles(packageDir, "src"), ...sourceFiles(packageDir, "test")]) {
        const source = readFileSync(file, "utf8");
        for (const pattern of [
          /import\(\s*["'][^"']*adc-?os\/[^"']*["']\s*\)/i,
          /import\(\s*["'][^"']*@adcos\/[^"']*["']\s*\)/i,
          /require\(\s*["'][^"']*adc-?os\/[^"']*["']\s*\)/i,
        ]) {
          if (pattern.test(source)) {
            offenders.push(relative(REPO_ROOT, file));
          }
        }
      }
    }
    expect(offenders, `dynamic ADCOS internal imports: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("the enterprise contract mirrors its owning vocabularies (drift guards, RL-LOCK-018)", () => {
  it("the customer-webhook source-aggregate mirror matches the notifications owner (RL-LOCK-009)", () => {
    const mirror = vocabularyValues(
      "packages/enterprise/src/webhooks.ts",
      "ENTERPRISE_WEBHOOK_SOURCE_AGGREGATE_TYPES",
    ).sort();
    const owner = vocabularyValues(
      "packages/notifications/src/notification.ts",
      "NOTIFICATION_SOURCE_AGGREGATE_TYPES",
    ).sort();
    expect(
      mirror,
      "the customer webhook aggregate-type vocabulary drifted from the notifications TransitionOrigin owner (RoamLink-owned aggregates ONLY - an ADCOS resource type can never appear)",
    ).toEqual(owner);
  });

  it("the enterprise mutation-stage mirror matches the application-kit owner (spec/api.md)", () => {
    const mirror = vocabularyValues(
      "packages/enterprise/src/api-surface.ts",
      "ENTERPRISE_MUTATION_STAGES",
    ).sort();
    const owner = vocabularyValues(
      "packages/app-kit/src/api/outcomes.ts",
      "MUTATION_OUTCOME_STAGES",
    ).sort();
    expect(
      mirror,
      "the enterprise acknowledgement stages drifted from the application contract owner",
    ).toEqual(owner);
  });

  it("the mobile shell's contract version uses the same major.minor discipline as the edge contracts", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/mobile/src/enrollment.ts"), "utf8");
    expect(source).toContain('MOBILE_SHELL_CONTRACT_VERSION = "0.1"');
    // The enrollment signature algorithm is pinned, never caller-chosen.
    expect(source).toContain('"hmac-sha256"');
  });

  it("the enterprise package version gate exists and is fail-closed", () => {
    const source = readFileSync(join(REPO_ROOT, "packages/enterprise/src/version.ts"), "utf8");
    expect(source).toContain("isSameMajorVersion");
    expect(source).toContain("contractVersionMinor(version) <= contractVersionMinor(ENTERPRISE_CONTRACT_VERSION)");
  });
});

describe("RL-LOCK-009 structural proof (customer webhooks, source-level)", () => {
  it("the durable-state-transition contract is closed to RoamLink-only shapes", () => {
    const source = readFileSync(join(REPO_ROOT, "packages/enterprise/src/webhooks.ts"), "utf8");
    // The origin vocabulary is SINGLE-MEMBER and RoamLink-owned: a raw ADCOS
    // payload has no origin value that fits (runtime negative proofs live in
    // packages/enterprise/test/webhooks.test.ts; this guard pins the source
    // contract itself).
    expect(source).toContain('export const CUSTOMER_WEBHOOK_ORIGIN = "roamlink_state_transition" as const;');
    // The parser's field set is closed: unknown fields (any ADCOS-shaped
    // smuggle) are rejected.
    expect(source).toContain('"unknown field (the transition-origin vocabulary is closed');
    // The durable event id (the emission receipt) is REQUIRED.
    expect(source).toContain("no receipt, no emission");
    // The dispatcher validates BEFORE any sink delivery.
    expect(source).toContain("parseDurableStateTransition(transition)");
  });
});

