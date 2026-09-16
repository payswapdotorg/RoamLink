import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Wave-3 Worker A packages (RL-022 payments inside domain-commerce,
 * RL-023 commerce-connectivity, RL-014 notifications) must keep the
 * three-worker-safe dependency direction (RL-LOCK-019,
 * spec/repository-layout.md "Dependency direction") and the
 * state-separation discipline (spec/data-model.md "State separation",
 * RL-LOCK-008/010):
 *
 *  - `commerce-connectivity` may depend on contracts, persistence and
 *    domain-commerce (subject facts + idempotency ledger); testkit is
 *    test-only. It must NOT import @roamlink/projections at all - the
 *    projection read surface is owned by the integration boundary
 *    (spec §8), so the DeliveryEvidenceSource port binding belongs to the
 *    composition layer, never to a domain package (RL-LOCK-002; enforced
 *    jointly with the RL-035 boundary test);
 *  - `notifications` may depend on contracts and persistence ONLY -
 *    commerce/connectivity references enter as typed related-ref values
 *    through ports, never as package imports (RL-LOCK-019);
 *  - neither package imports the ADCOS contract package or the
 *    integration boundary (RL-LOCK-002) - in addition to the repo-wide
 *    forbidden-imports test;
 *  - `domain-commerce` keeps its pinned dependency set (contracts +
 *    persistence) and gains NO connectivity/delivery vocabulary from the
 *    RL-022 extension;
 *  - the spec-listed state vocabularies (customer_payment_state,
 *    order_state, customer_subscription_state, delivery_evidence_state,
 *    notification/support states) stay SEPARATE definitions in SEPARATE
 *    modules - a merged enum fails these checks (RL-LOCK-018: tests
 *    prove architecture).
 */
const ALLOWED_COMMERCE_CONNECTIVITY_DEPS = [
  "@roamlink/contracts",
  "@roamlink/persistence",
  "@roamlink/domain-commerce",
] as const;

const ALLOWED_NOTIFICATIONS_DEPS = [
  "@roamlink/contracts",
  "@roamlink/persistence",
] as const;

/** The integration-boundary + platform packages neither new package may touch. */
const FORBIDDEN_IMPORTS = [
  "@roamlink/adcos",
  "@roamlink/integration",
  "@roamlink/webhook-inbox",
  "@roamlink/reconciliation",
  "@roamlink/compat",
  "@roamlink/projections",
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

describe("Wave-3 Worker A packages keep the dependency direction (RL-LOCK-019)", () => {
  it.each([
    ["packages/commerce-connectivity", ALLOWED_COMMERCE_CONNECTIVITY_DEPS],
    ["packages/notifications", ALLOWED_NOTIFICATIONS_DEPS],
  ] as const)("%s declares only allowed RoamLink dependencies", (packageDir, allowed) => {
    const manifest = readManifest(packageDir);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      for (const dep of roamlinkDeps) {
        expect(
          allowed,
          `${packageDir} ${field} declares the non-test dependency '${dep}'`,
        ).toContain(dep);
      }
    }
    const devDeps = manifest["devDependencies"];
    if (devDeps !== undefined) {
      const roamlinkDevDeps = Object.keys(devDeps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDevDeps, `${packageDir} may only dev-depend on @roamlink/testkit`).toEqual([
        "@roamlink/testkit",
      ]);
    }
  });

  it.each([
    ["packages/commerce-connectivity", ALLOWED_COMMERCE_CONNECTIVITY_DEPS],
    ["packages/notifications", ALLOWED_NOTIFICATIONS_DEPS],
  ] as const)("%s src imports only the declared boundary packages", (packageDir, allowed) => {
    const offenders: string[] = [];
    for (const file of sourceFiles(packageDir, "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (!(allowed as readonly string[]).includes(imported)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(offenders, `forbidden imports: ${offenders.join(", ")}`).toEqual([]);
  });

  it("neither new package imports the ADCOS contract package or the integration boundary (RL-LOCK-002)", () => {
    const offenders: string[] = [];
    for (const packageDir of ["packages/commerce-connectivity", "packages/notifications"]) {
      for (const file of [...sourceFiles(packageDir, "src"), ...sourceFiles(packageDir, "test")]) {
        for (const imported of roamlinkImportsOf(file)) {
          if ((FORBIDDEN_IMPORTS as readonly string[]).includes(imported)) {
            offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
          }
        }
      }
    }
    expect(offenders, `integration-boundary leaks: ${offenders.join(", ")}`).toEqual([]);
  });

  it("notifications references commerce/connectivity through PORTS only (no domain package imports)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("packages/notifications", "src")) {
      for (const imported of roamlinkImportsOf(file)) {
        if (
          [
            "@roamlink/domain-commerce",
            "@roamlink/commerce-connectivity",
            "@roamlink/domain-experience",
          ].includes(imported)
        ) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(
      offenders,
      `notifications must not import sibling domain packages (typed related-ref ports only): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("commerce-connectivity never imports @roamlink/projections (the evidence port binds at the composition layer, RL-LOCK-002)", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("packages/commerce-connectivity", "src"), ...sourceFiles("packages/commerce-connectivity", "test")]) {
      for (const imported of roamlinkImportsOf(file)) {
        if (imported === "@roamlink/projections") {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${imported}`);
        }
      }
    }
    expect(
      offenders,
      `domain packages must not import the projection package (the integration boundary exposes the read surface; the composition layer binds it to the DeliveryEvidenceSource port): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the linkable canonical-resource vocabulary is pinned to the real projection §8 vocabulary (mirror drift guard)", () => {
    const projectionsSource = readFileSync(
      join(REPO_ROOT, "packages", "projections", "src", "projection-record.ts"),
      "utf8",
    );
    const match = projectionsSource.match(
      /export const ADCOS_PROJECTION_RESOURCE_TYPES = \[([^\]]+)\] as const/,
    );
    expect(match, "the projection package must still define ADCOS_PROJECTION_RESOURCE_TYPES").not.toBe(
      null,
    );
    const projectionVocabulary = (match?.[1] ?? "")
      .split(",")
      .map((token) => token.trim().replace(/^["']|["']$/g, ""))
      .filter((token) => token.length > 0);
    const referenceSource = readFileSync(
      join(REPO_ROOT, "packages", "commerce-connectivity", "src", "delivery-evidence.ts"),
      "utf8",
    );
    const referenceMatch = referenceSource.match(
      /export const LINKABLE_CANONICAL_RESOURCE_TYPES = \[([^\]]+)\] as const/,
    );
    expect(referenceMatch, "the reference model must define LINKABLE_CANONICAL_RESOURCE_TYPES").not.toBe(
      null,
    );
    const referenceVocabulary = (referenceMatch?.[1] ?? "")
      .split(",")
      .map((token) => token.trim().replace(/^["']|["']$/g, ""))
      .filter((token) => token.length > 0);
    expect(referenceVocabulary.sort()).toEqual(projectionVocabulary.sort());
  });

  it("domain-commerce still depends only on contracts + persistence and gained no delivery vocabulary", () => {
    const manifest = readManifest("packages/domain-commerce");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      const roamlinkDeps = Object.keys(deps).filter((name) => name.startsWith("@roamlink/"));
      expect(roamlinkDeps.sort()).toEqual(["@roamlink/contracts", "@roamlink/persistence"]);
    }
    const offenders: string[] = [];
    for (const file of sourceFiles("packages/domain-commerce", "src")) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        "AdcosIntentRef",
        "AdcosContractRef",
        "AdcosLeaseRef",
        "AdcosSessionRef",
        "AdcosPathRef",
        "reservationState",
        "sessionState",
        "deliveryEvidenceState",
        "DELIVERY_EVIDENCE_STATES",
        "UNEVIDENCED",
      ]) {
        if (source.includes(forbidden)) {
          offenders.push(`${relative(REPO_ROOT, file)} -> ${forbidden}`);
        }
      }
    }
    expect(
      offenders,
      `commerce must not model connectivity/delivery state (RL-LOCK-008): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("state separation stays structural (spec/data-model.md, RL-LOCK-018)", () => {
  it("every spec-listed state vocabulary is a SEPARATE definition in its OWN module", () => {
    const expected: ReadonlyArray<{
      readonly file: string;
      readonly vocabulary: string;
    }> = [
      { file: "packages/domain-commerce/src/order.ts", vocabulary: "ORDER_STATUSES" },
      { file: "packages/domain-commerce/src/subscription.ts", vocabulary: "SUBSCRIPTION_STATUSES" },
      { file: "packages/domain-commerce/src/payment.ts", vocabulary: "CUSTOMER_PAYMENT_STATES" },
      { file: "packages/domain-commerce/src/invoice.ts", vocabulary: "CUSTOMER_INVOICE_STATES" },
      { file: "packages/domain-commerce/src/refund.ts", vocabulary: "CUSTOMER_REFUND_STATES" },
      {
        file: "packages/commerce-connectivity/src/delivery-evidence.ts",
        vocabulary: "DELIVERY_EVIDENCE_STATES",
      },
      { file: "packages/notifications/src/notification.ts", vocabulary: "NOTIFICATION_STATES" },
      { file: "packages/notifications/src/support-case.ts", vocabulary: "SUPPORT_CASE_STATES" },
    ];
    for (const { file, vocabulary } of expected) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(
        source.includes(`export const ${vocabulary}`),
        `${file} must define its own ${vocabulary} (a merged/aliased enum fails this)`,
      ).toBe(true);
    }
  });

  it("no single exported vocabulary swallows values from two state families (anti-merge drift guard)", () => {
    // Extract the exported const arrays from each module and assert no
    // vocabulary's value set is a SUPERSET of another family's values
    // beyond the shared neutral token "pending"/"cancelled" where two
    // families legitimately reuse a word (they remain separate enums).
    const families: ReadonlyArray<{ readonly name: string; readonly file: string }> = [
      { name: "ORDER_STATUSES", file: "packages/domain-commerce/src/order.ts" },
      { name: "SUBSCRIPTION_STATUSES", file: "packages/domain-commerce/src/subscription.ts" },
      { name: "CUSTOMER_PAYMENT_STATES", file: "packages/domain-commerce/src/payment.ts" },
      { name: "CUSTOMER_INVOICE_STATES", file: "packages/domain-commerce/src/invoice.ts" },
      { name: "CUSTOMER_REFUND_STATES", file: "packages/domain-commerce/src/refund.ts" },
      {
        name: "DELIVERY_EVIDENCE_STATES",
        file: "packages/commerce-connectivity/src/delivery-evidence.ts",
      },
      { name: "NOTIFICATION_STATES", file: "packages/notifications/src/notification.ts" },
      { name: "SUPPORT_CASE_STATES", file: "packages/notifications/src/support-case.ts" },
    ];
    const valuesOf = (file: string, name: string): string[] => {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\] as const`));
      expect(match, `${file} must define ${name} as a const array`).not.toBeNull();
      return (match?.[1] ?? "")
        .split(",")
        .map((token) => token.trim().replace(/^["']|["']$/g, ""))
        .filter((token) => token.length > 0);
    };
    for (const outer of families) {
      const outerValues = valuesOf(outer.file, outer.name);
      expect(outerValues.length, `${outer.name} must not be empty`).toBeGreaterThan(0);
      for (const inner of families) {
        if (inner.name === outer.name) continue;
        const innerValues = valuesOf(inner.file, inner.name);
        const swallowed = innerValues.filter((value) => outerValues.includes(value));
        // Separate aggregates may legitimately reuse neutral lifecycle
        // words (pending/cancelled for commerce lifecycles,
        // succeeded/failed for money lifecycles) - they remain SEPARATE
        // enums. Anything else absorbed from another family means a merge
        // happened (order/payment blends, delivery-evidence tokens in
        // commerce, notification/support states in commerce, ...).
        const allowedShared = ["pending", "cancelled", "succeeded", "failed"];
        const illegal = swallowed.filter((value) => !allowedShared.includes(value));
        expect(
          illegal,
          `${outer.name} absorbed values from ${inner.name}: ${illegal.join(", ")} (state vocabularies must never merge)`,
        ).toEqual([]);
      }
    }
  });

  it("the payment/invoice/refund modules contain no order/subscription vocabulary tokens", () => {
    const offenders: string[] = [];
    for (const file of [
      "packages/domain-commerce/src/payment.ts",
      "packages/domain-commerce/src/invoice.ts",
      "packages/domain-commerce/src/refund.ts",
    ]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const forbidden of ["ORDER_STATUSES", "SUBSCRIPTION_STATUSES", "ORDER_TRANSITIONS"]) {
        if (source.includes(forbidden)) {
          offenders.push(`${file} -> ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
