import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-4 Worker A packages (RL-060 apps/web + RL-061 apps/admin over the new
 * packages/app-kit) must keep the frozen dependency direction and the
 * no-authority-logic layout lock (RL-LOCK-019, spec/repository-layout.md
 * "apps consume public application APIs/read models and do not contain
 * authority logic"):
 *
 *  - apps may depend ONLY on @roamlink/app-kit (+ testkit as a dev
 *    dependency); their sources may import ONLY @roamlink/app-kit - never a
 *    domain, integration, edge or platform package, and never node builtins
 *    (apps are pure presentation: no direct DB/ADCOS/OS access exists);
 *  - app-kit may depend ONLY on @roamlink/contracts and mirror nothing
 *    authoritatively: its state vocabularies are CONTRACT mirrors of the
 *    owning domain packages' closed vocabularies, and a drift between a
 *    mirror and its owner fails here (RL-LOCK-018: tests prove
 *    architecture);
 *  - the app contract's state vocabularies stay SEPARATE (no app-level
 *    vocabulary absorbs another family's values - the same anti-merge
 *    discipline the domain packages are held to, because the apps must
 *    never collapse the states the domain separates).
 */

const APP_PACKAGES = ["apps/web", "apps/admin"] as const;
const APP_KIT = "packages/app-kit" as const;

/** Every RoamLink package an app must NEVER import (authority owners). */
const FORBIDDEN_FOR_APPS = [
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
  "@roamlink/edge-connector",
  "@roamlink/intent-compiler",
  "@roamlink/observability",
  "@roamlink/audit",
  "@roamlink/secrets",
  "@roamlink/retention",
  "@roamlink/resilience",
] as const;

const ALLOWED_APP_KIT_DEPS = ["@roamlink/contracts"] as const;

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

describe("Wave-4 Worker A package boundaries (RL-LOCK-019, no authority in apps)", () => {
  it.each([...APP_PACKAGES] as const)("%s declares only app-kit (+ testkit dev)", (packageDir) => {
    const manifest = readManifest(packageDir);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(
        roamlinkDeps.sort(),
        `${packageDir} ${field} must depend only on @roamlink/app-kit`,
      ).toEqual(["@roamlink/app-kit"]);
    }
    const devDeps = manifest["devDependencies"];
    if (devDeps !== undefined) {
      const roamlinkDevDeps = Object.keys(devDeps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDevDeps, `${packageDir} may only dev-depend on @roamlink/testkit`).toEqual([
        "@roamlink/testkit",
      ]);
    }
  });

  it.each([...APP_PACKAGES] as const)("%s src imports only @roamlink/app-kit (no domain/integration/platform packages)", (packageDir) => {
    const offenders: string[] = [];
    for (const file of sourceFiles(packageDir, "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (imported !== "@roamlink/app-kit") {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(
      offenders,
      `apps must consume only the application kit: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it.each([...APP_PACKAGES] as const)("%s never imports a forbidden authority package anywhere (src or test)", (packageDir) => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(packageDir, "src"), ...sourceFiles(packageDir, "test")]) {
      for (const imported of roamlinkImportsOf(file)) {
        if ((FORBIDDEN_FOR_APPS as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `authority leaks into the app: ${offenders.join(", ")}`).toEqual([]);
  });

  it.each([...APP_PACKAGES, APP_KIT] as const)("%s src never imports node builtins (pure presentation layer)", (packageDir) => {
    const offenders: string[] = [];
    for (const file of sourceFiles(packageDir, "src")) {
      for (const imported of nodeImportsOf(file)) {
        offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
      }
    }
    expect(
      offenders,
      `app sources must stay runtime-agnostic (no OS/DB/FS access exists in apps): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("app-kit declares only @roamlink/contracts (+ testkit dev)", () => {
    const manifest = readManifest(APP_KIT);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      for (const dep of roamlinkDeps) {
        expect(ALLOWED_APP_KIT_DEPS, `${APP_KIT} ${field} declares '${dep}'`).toContain(dep);
      }
    }
    const devDeps = manifest["devDependencies"];
    if (devDeps !== undefined) {
      const roamlinkDevDeps = Object.keys(devDeps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDevDeps).toEqual(["@roamlink/testkit"]);
    }
  });

  it("app-kit src imports only @roamlink/contracts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(APP_KIT, "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(ALLOWED_APP_KIT_DEPS as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `app-kit boundary violations: ${offenders.join(", ")}`).toEqual([]);
  });

  it("apps never reference ADCOS internals through stringly imports either (dynamic import scan)", () => {
    const offenders: string[] = [];
    for (const packageDir of [...APP_PACKAGES, APP_KIT] as const) {
      for (const file of [...sourceFiles(packageDir, "src"), ...sourceFiles(packageDir, "test")]) {
        const source = readFileSync(file, "utf8");
        for (const pattern of [
          /import\(\s*["'][^"']*adc-?os\/[^"']*["']\s*\)/i,
          /import\(\s*["'][^"']*@adcos\/[^"']*["']\s*\)/i,
          /require\(\s*["'][^"']*adc-?os\/[^"']*["']\s*\)/i,
        ]) {
          if (pattern.test(source)) {
            offenders.push(`${relative(REPO_ROOT, file)}`);
          }
        }
      }
    }
    expect(offenders, `dynamic ADCOS internal imports: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("the app contract mirrors the owning domain vocabularies (drift guards, RL-LOCK-018)", () => {
  const MIRRORS: ReadonlyArray<{
    readonly mirrorFile: string;
    readonly mirror: string;
    readonly ownerFile: string;
    readonly owner: string;
    readonly label: string;
  }> = [
    {
      label: "device statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "DEVICE_RESOURCE_STATUSES",
      ownerFile: "packages/domain-experience/src/device/device.ts",
      owner: "DEVICE_STATUSES",
    },
    {
      label: "experience intent statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "INTENT_RESOURCE_STATUSES",
      ownerFile: "packages/domain-experience/src/intent/experience-intent.ts",
      owner: "EXPERIENCE_INTENT_STATUSES",
    },
    {
      label: "derived experience statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "DERIVED_EXPERIENCE_STATUSES",
      ownerFile: "packages/domain-experience/src/decision/derived-status.ts",
      owner: "DERIVED_EXPERIENCE_STATUSES",
    },
    {
      label: "order statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "ORDER_RESOURCE_STATUSES",
      ownerFile: "packages/domain-commerce/src/order.ts",
      owner: "ORDER_STATUSES",
    },
    {
      label: "subscription statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "SUBSCRIPTION_RESOURCE_STATUSES",
      ownerFile: "packages/domain-commerce/src/subscription.ts",
      owner: "SUBSCRIPTION_STATUSES",
    },
    {
      label: "customer payment states",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "CUSTOMER_PAYMENT_RESOURCE_STATES",
      ownerFile: "packages/domain-commerce/src/payment.ts",
      owner: "CUSTOMER_PAYMENT_STATES",
    },
    {
      label: "customer invoice states",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "CUSTOMER_INVOICE_RESOURCE_STATES",
      ownerFile: "packages/domain-commerce/src/invoice.ts",
      owner: "CUSTOMER_INVOICE_STATES",
    },
    {
      label: "delivery evidence states",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "DELIVERY_EVIDENCE_RESOURCE_STATES",
      ownerFile: "packages/commerce-connectivity/src/delivery-evidence.ts",
      owner: "DELIVERY_EVIDENCE_STATES",
    },
    {
      label: "notification states",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "NOTIFICATION_RESOURCE_STATES",
      ownerFile: "packages/notifications/src/notification.ts",
      owner: "NOTIFICATION_STATES",
    },
    {
      label: "support case states",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "SUPPORT_CASE_RESOURCE_STATES",
      ownerFile: "packages/notifications/src/support-case.ts",
      owner: "SUPPORT_CASE_STATES",
    },
    {
      label: "account permissions",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "ACCOUNT_PERMISSION_VOCABULARY",
      ownerFile: "packages/auth/src/membership.ts",
      owner: "ACCOUNT_PERMISSIONS",
    },
    {
      label: "canonical resource types",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "CANONICAL_RESOURCE_TYPE_VOCABULARY",
      ownerFile: "packages/projections/src/projection-record.ts",
      owner: "ADCOS_PROJECTION_RESOURCE_TYPES",
    },
    {
      label: "reconciliation job statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "RECONCILIATION_JOB_RESOURCE_STATUSES",
      ownerFile: "packages/reconciliation/src/job-record.ts",
      owner: "RECONCILIATION_JOB_STATUSES",
    },
    {
      label: "reconciliation action outcomes",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "RECONCILIATION_ACTION_OUTCOME_VOCABULARY",
      ownerFile: "packages/reconciliation/src/job-record.ts",
      owner: "RECONCILIATION_ACTION_OUTCOMES",
    },
    {
      label: "audit event categories",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "AUDIT_EVENT_CATEGORIES_VOCABULARY",
      ownerFile: "packages/audit/src/audit-event.ts",
      owner: "AUDIT_EVENT_CATEGORIES",
    },
    {
      label: "audit event outcomes",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "AUDIT_EVENT_OUTCOMES_VOCABULARY",
      ownerFile: "packages/audit/src/audit-event.ts",
      owner: "AUDIT_EVENT_OUTCOMES",
    },
    {
      label: "organization statuses",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "ORGANIZATION_RESOURCE_STATUSES",
      ownerFile: "packages/auth/src/organization.ts",
      owner: "ORGANIZATION_STATUSES",
    },
    {
      label: "membership roles",
      mirrorFile: "packages/app-kit/src/api/resources.ts",
      mirror: "MEMBERSHIP_ROLES_VOCABULARY",
      ownerFile: "packages/auth/src/membership.ts",
      owner: "MEMBERSHIP_ROLES",
    },
  ];

  it.each(MIRRORS)("the app contract's $label mirror matches the owning domain vocabulary", ({ mirrorFile, mirror, ownerFile, owner }) => {
    const mirrorValues = vocabularyValues(mirrorFile, mirror).sort();
    const ownerValues = vocabularyValues(ownerFile, owner).sort();
    expect(
      mirrorValues,
      `the app contract mirror ${mirror} drifted from ${ownerFile}'s ${owner} (the API contract must mirror the owning domain, never redefine it)`,
    ).toEqual(ownerValues);
  });

  it("no app-contract vocabulary absorbs another state family's values (anti-merge)", () => {
    const families: ReadonlyArray<{ readonly name: string; readonly file: string }> = [
      { name: "DEVICE_RESOURCE_STATUSES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "INTENT_RESOURCE_STATUSES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "ORDER_RESOURCE_STATUSES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "SUBSCRIPTION_RESOURCE_STATUSES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "CUSTOMER_PAYMENT_RESOURCE_STATES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "CUSTOMER_INVOICE_RESOURCE_STATES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "DELIVERY_EVIDENCE_RESOURCE_STATES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "NOTIFICATION_RESOURCE_STATES", file: "packages/app-kit/src/api/resources.ts" },
      { name: "SUPPORT_CASE_RESOURCE_STATES", file: "packages/app-kit/src/api/resources.ts" },
    ];
    for (const outer of families) {
      const outerValues = vocabularyValues(outer.file, outer.name);
      expect(outerValues.length, `${outer.name} must not be empty`).toBeGreaterThan(0);
      for (const inner of families) {
        if (inner.name === outer.name) continue;
        const innerValues = vocabularyValues(inner.file, inner.name);
        const swallowed = innerValues.filter((value) => outerValues.includes(value));
        // Neutral lifecycle words are legitimately reused across SEPARATE
        // families (the domain vocabularies do the same: 'active' devices,
        // intents, subscriptions; 'draft' intents/orders/products; ...) -
        // they remain separate enums. Anything else absorbed from another
        // family means a merge happened at the app-contract level.
        const allowedShared = [
          "pending",
          "cancelled",
          "succeeded",
          "failed",
          "active",
          "suspended",
          "draft",
          "expired",
          "retired",
          // 'superseded' is the shared supersession-chain concept the data
          // model applies to BOTH intent versions and subscription changes
          // (spec/data-model.md "Versioning"): both owning domain
          // vocabularies carry it as separate enums.
          "superseded",
        ];
        const illegal = swallowed.filter((value) => !allowedShared.includes(value));
        expect(
          illegal,
          `${outer.name} absorbed values from ${inner.name}: ${illegal.join(", ")} (the app contract must never merge state families)`,
        ).toEqual([]);
      }
    }
  });
});
