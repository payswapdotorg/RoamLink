/**
 * The RL-001..RL-075 work-item representation manifest + evaluator (MVP
 * criterion 1: "every work item RL-001..075 represented on main with tests
 * green").
 *
 * The mapping is data. Each entry names the concrete repository artifacts
 * that REPRESENT the work item (packages, apps, suites, docs) and the test
 * suites that own its correctness. The evaluator verifies mechanically:
 *
 *  - every required path exists on the tree (representation);
 *  - every owning suite ran green in the gate's test step (tests green).
 *
 * Source of the mapping: spec/work-items.md + README.md "Package layout".
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{ id: string, title: string, paths: readonly string[], suites: readonly string[], note?: string }} WorkItem
 */

/** @type {readonly WorkItem[]} */
export const WORK_ITEMS = Object.freeze([
  {
    id: "RL-001",
    title: "Repo/CI foundation",
    paths: ["package.json", "eslint.config.mjs", ".github/workflows/ci.yml", "scripts/check-architecture.mjs", ".env.example", "pnpm-workspace.yaml"],
    suites: ["@roamlink/tests-architecture"],
  },
  {
    id: "RL-002",
    title: "Architecture contracts",
    paths: ["packages/contracts/src/index.ts", "packages/contracts/test"],
    suites: ["@roamlink/contracts"],
  },
  {
    id: "RL-003",
    title: "Persistence/queue primitives",
    paths: ["packages/persistence/src", "packages/persistence/test"],
    suites: ["@roamlink/persistence"],
  },
  {
    id: "RL-004",
    title: "Auth/tenant boundary",
    paths: ["packages/auth/src", "packages/auth/test"],
    suites: ["@roamlink/auth"],
  },
  {
    id: "RL-010",
    title: "Device registry",
    paths: ["packages/domain-experience/src/device", "packages/domain-experience/src/device-registry-service.ts"],
    suites: ["@roamlink/domain-experience"],
  },
  {
    id: "RL-011",
    title: "ExperienceIntent",
    paths: ["packages/domain-experience/src/intent", "packages/domain-experience/src/experience-intent-service.ts"],
    suites: ["@roamlink/domain-experience"],
  },
  {
    id: "RL-012",
    title: "Intent compiler",
    paths: ["packages/intent-compiler/src", "packages/intent-compiler/test"],
    suites: ["@roamlink/intent-compiler"],
  },
  {
    id: "RL-013",
    title: "Experience decision/read model",
    paths: ["packages/domain-experience/src/decision"],
    suites: ["@roamlink/domain-experience"],
  },
  {
    id: "RL-014",
    title: "Notifications/support",
    paths: ["packages/notifications/src", "packages/notifications/test"],
    suites: ["@roamlink/notifications"],
  },
  {
    id: "RL-020",
    title: "Product/catalog",
    paths: ["packages/domain-commerce/src/product.ts", "packages/domain-commerce/src/product-variant.ts", "packages/domain-commerce/src/catalog.ts"],
    suites: ["@roamlink/domain-commerce"],
  },
  {
    id: "RL-021",
    title: "Order/subscription lifecycle",
    paths: ["packages/domain-commerce/src/order.ts", "packages/domain-commerce/src/subscription.ts"],
    suites: ["@roamlink/domain-commerce"],
  },
  {
    id: "RL-022",
    title: "Customer payments/invoices/refunds",
    paths: ["packages/domain-commerce/src/payment.ts", "packages/domain-commerce/src/invoice.ts", "packages/domain-commerce/src/refund.ts"],
    suites: ["@roamlink/domain-commerce"],
  },
  {
    id: "RL-023",
    title: "Commerce-to-connectivity reference model",
    paths: ["packages/commerce-connectivity/src", "packages/commerce-connectivity/test"],
    suites: ["@roamlink/commerce-connectivity"],
  },
  {
    id: "RL-030",
    title: "ADCOS public-client contract",
    paths: ["packages/adcos/src/client.ts", "packages/adcos/src/routes.ts", "packages/adcos/src/contract-state.ts"],
    suites: ["@roamlink/adcos"],
  },
  {
    id: "RL-031",
    title: "ADCOS intent adapter",
    paths: ["packages/integration/src/intent-adapter.ts", "packages/integration/src/intent-command.ts"],
    suites: ["@roamlink/integration"],
  },
  {
    id: "RL-032",
    title: "Offer/reservation adapter",
    paths: ["packages/integration/src/offer-reservation-adapter.ts"],
    suites: ["@roamlink/integration"],
  },
  {
    id: "RL-033",
    title: "Webhook inbox",
    paths: ["packages/webhook-inbox/src", "packages/webhook-inbox/test"],
    suites: ["@roamlink/webhook-inbox"],
  },
  {
    id: "RL-034",
    title: "Projection engine",
    paths: ["packages/projections/src", "packages/projections/test"],
    suites: ["@roamlink/projections"],
  },
  {
    id: "RL-035",
    title: "Reconciliation engine",
    paths: ["packages/reconciliation/src", "packages/reconciliation/test"],
    suites: ["@roamlink/reconciliation"],
  },
  {
    id: "RL-036",
    title: "ADCOS compatibility suite",
    paths: ["packages/compat/src", "packages/compat/test"],
    suites: ["@roamlink/compat"],
  },
  {
    id: "RL-040",
    title: "Edge capability contract + platform observability contracts",
    paths: ["packages/edge/src/capability", "packages/observability/src/index.ts"],
    suites: ["@roamlink/edge", "@roamlink/observability"],
    note: "RL-040 spans the edge capability contract (@roamlink/edge) and the platform observability contracts (@roamlink/observability) per README package layout.",
  },
  {
    id: "RL-041",
    title: "Edge observation engine",
    paths: ["packages/edge/src/observation"],
    suites: ["@roamlink/edge"],
  },
  {
    id: "RL-042",
    title: "Encrypted offline outbox/sync",
    paths: ["packages/edge/src/sync"],
    suites: ["@roamlink/edge"],
  },
  {
    id: "RL-043",
    title: "Device action adapter",
    paths: ["packages/edge-actions/src", "packages/edge-actions/test"],
    suites: ["@roamlink/edge-actions"],
  },
  {
    id: "RL-044",
    title: "Enterprise edge connector contract",
    paths: ["packages/edge-connector/src", "packages/edge-connector/test"],
    suites: ["@roamlink/edge-connector"],
  },
  {
    id: "RL-050",
    title: "Secrets/credentials boundary",
    paths: ["packages/secrets/src", "packages/secrets/test"],
    suites: ["@roamlink/secrets"],
  },
  {
    id: "RL-051",
    title: "Audit/security events",
    paths: ["packages/audit/src", "packages/audit/test"],
    suites: ["@roamlink/audit"],
  },
  {
    id: "RL-052",
    title: "Observability/SLO instrumentation",
    paths: ["packages/observability/src/slo", "packages/observability/src/health"],
    suites: ["@roamlink/observability"],
  },
  {
    id: "RL-053",
    title: "Rate limits/retries/circuit breakers",
    paths: ["packages/resilience/src", "packages/resilience/test"],
    suites: ["@roamlink/resilience"],
  },
  {
    id: "RL-054",
    title: "Data retention/privacy enforcement",
    paths: ["packages/retention/src", "packages/retention/test"],
    suites: ["@roamlink/retention"],
  },
  {
    id: "RL-060",
    title: "Customer web application",
    paths: ["apps/web/src", "apps/web/test"],
    suites: ["@roamlink/web"],
  },
  {
    id: "RL-061",
    title: "Admin/operations console",
    paths: ["apps/admin/src", "apps/admin/test"],
    suites: ["@roamlink/admin"],
  },
  {
    id: "RL-062",
    title: "Mobile/edge UX shell",
    paths: ["apps/mobile/src", "apps/mobile/test"],
    suites: ["@roamlink/mobile"],
  },
  {
    id: "RL-063",
    title: "Enterprise onboarding/API surface",
    paths: ["packages/enterprise/src/api-surface.ts", "packages/enterprise/src/enrollment.ts", "packages/enterprise/test"],
    suites: ["@roamlink/enterprise"],
  },
  {
    id: "RL-070",
    title: "Authority conformance suite",
    paths: ["tests/conformance/test"],
    suites: ["@roamlink/tests-conformance"],
  },
  {
    id: "RL-071",
    title: "Failure/reordering/duplicate simulation",
    paths: ["tests/simulation/test"],
    suites: ["@roamlink/tests-simulation"],
  },
  {
    id: "RL-072",
    title: "End-to-end dogfood scenarios",
    paths: ["tests/dogfood/test", "tests/dogfood/src/world.ts"],
    suites: ["@roamlink/tests-dogfood"],
  },
  {
    id: "RL-073",
    title: "Load/reliability tests",
    paths: ["tests/load/test", "tests/load/src/harness.ts"],
    suites: ["@roamlink/tests-load"],
  },
  {
    id: "RL-074",
    title: "Security/threat-model verification",
    paths: ["tests/security/test", "docs/threat-model-verification.md"],
    suites: ["@roamlink/tests-security"],
  },
  {
    id: "RL-075",
    title: "Deployment/recovery verification",
    paths: ["tests/deployment/test", "docs/deployment-recovery.md"],
    suites: ["@roamlink/tests-deployment"],
  },
]);

/**
 * Evaluates MVP criterion 1: every work item RL-001..075 represented with
 * tests green.
 *
 * @param {string} repoRoot
 * @param {Record<string, { status: string, exitCode?: number, tests?: { passed: number, failed: number, total: number } }>} suiteResults — keyed by suite package name, from the gate's test step.
 * @param {readonly WorkItem[]} [manifest=WORK_ITEMS] — injectable for machinery tests on fixture trees.
 * @returns {{ id: string, requirement: string, status: "pass" | "fail", rows: Array<{ id: string, status: "pass" | "fail", summary: string, evidence: string[] }>, summary: string }}
 */
export function evaluateWorkItems(repoRoot, suiteResults, manifest = WORK_ITEMS) {
  const rows = manifest.map((item) => {
    const missingPaths = item.paths.filter((path) => !existsSync(join(repoRoot, path)));
    const suiteEvidence = item.suites.map((suite) => {
      const result = suiteResults[suite];
      if (result === undefined) return { suite, ok: false, detail: "suite not present in the gate test step" };
      const ok = result.status === "pass";
      return {
        suite,
        ok,
        detail: ok
          ? `green${result.tests ? ` (${result.tests.passed}/${result.tests.total} tests)` : ""}`
          : `NOT green (status ${result.status}${result.exitCode !== undefined ? `, exit ${result.exitCode}` : ""})`,
      };
    });
    const failingSuites = suiteEvidence.filter((entry) => !entry.ok);
    const represented = missingPaths.length === 0;
    const status = represented && failingSuites.length === 0 ? "pass" : "fail";
    return {
      id: item.id,
      status,
      summary: represented
        ? failingSuites.length === 0
          ? `${item.title} — represented; owning suite(s) green`
          : `${item.title} — represented; owning suite(s) not green: ${failingSuites.map((entry) => entry.suite).join(", ")}`
        : `${item.title} — NOT represented on main: missing ${missingPaths.join(", ")}`,
      evidence: [
        ...item.paths.map((path) => `${path} (exists: ${!missingPaths.includes(path)})`),
        ...suiteEvidence.map((entry) => `${entry.suite}: ${entry.detail}`),
      ],
    };
  });
  const failed = rows.filter((row) => row.status !== "pass");
  return {
    id: "MVP-1",
    requirement:
      "Every work item RL-001..RL-075 is represented on main (its packages/suites/docs exist) with tests green (owning suites passed in the gate's test step).",
    status: failed.length === 0 ? "pass" : "fail",
    rows,
    summary:
      failed.length === 0
        ? `all ${rows.length} work items represented with green owning suites`
        : `${failed.length}/${rows.length} work items failed: ${failed.map((row) => row.id).join(", ")}`,
  };
}
