/**
 * Wave-8 Worker B — RL-115 capability-discoverability drift-guards.
 *
 * spec/ux-architecture.md §15 makes discoverability an architectural
 * requirement, and spec/user-journey-audit.md line 199 says "a capability is
 * not considered discoverable merely because an API or page exists". These
 * structural guards pin the SURFACE FACTS the RL-115 audit was built from,
 * so the frozen capability inventory (apps/web/test/
 * rl115-capability-discoverability.test.ts) and its verdict matrix
 * (docs/capability-discoverability.md) cannot silently drift from the tree:
 *
 *  - the route and navigation vocabularies the inventory cites stay exact;
 *  - every capability row and every GAP finding stays in sync with the doc;
 *  - the §7 device-capability vocabulary the matrix rows cite stays closed;
 *  - the §11 SLO vocabulary the ops surface renders stays closed;
 *  - the recorded ABSENCES (eSIM management UX, SLO entry point, connector
 *    enrollment action, refund surface, SSO/SCIM/MDM surface, compatibility
 *    health surface, /orders inbound links, /notifications inbound links)
 *    stay truthful — if one of these tests FAILS because a surface changed,
 *    the inventory + doc MUST be updated in the same change.
 *
 * Structure-only (this package depends on no app): files are read and
 * scanned, never imported — the same pattern as the wave boundary guards.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function mustExist(path: string): void {
  expect(existsSync(join(REPO_ROOT, path)), `${path} must exist`).toBe(true);
}

function constArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\] as const`));
  expect(match, `expected 'export const ${name} = [...] as const'`).not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((token) => token.trim().replace(/^["']|["']$/g, ""))
    .filter((token) => token.length > 0);
}

// --------------------------------------------------------------------------------
// Guard 1 — the route/nav vocabularies the inventory cites stay exact
// --------------------------------------------------------------------------------

describe("RL-115 guard: the cited surface vocabularies stay frozen", () => {
  it("the web routes object keeps every named route the inventory references", () => {
    const source = read("apps/web/src/routes.ts");
    for (const name of [
      "home",
      "onboarding",
      "overview",
      "connectivity",
      "devices",
      "device",
      "intents",
      "intent",
      "commerce",
      "order",
      "activity",
      "notifications",
      "support",
      "case",
      "more",
      "settings",
      "workspace",
    ]) {
      expect(source, `route '${name}' must stay in WEB_PAGE_ROUTES`).toMatch(
        new RegExp(`\\b${name}:\\s*"/`),
      );
    }
  });

  it("DESKTOP_NAV / MOBILE_NAV keep the exact spec §3 destinations in order", () => {
    const app = read("apps/web/src/app.ts");
    const desktop = app.match(/export const DESKTOP_NAV = \[([\s\S]*?)\] as const/);
    const mobile = app.match(/export const MOBILE_NAV = \[([\s\S]*?)\] as const/);
    expect(desktop).not.toBeNull();
    expect(mobile).not.toBeNull();
    const labelsOf = (block: RegExpMatchArray | null): string[] =>
      [...(block?.[1] ?? "").matchAll(/label: "([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(labelsOf(desktop as RegExpMatchArray)).toEqual([
      "Home",
      "Connectivity",
      "Activity",
      "Devices",
      "Goals",
      "Plans & Billing",
      "Support",
    ]);
    expect(labelsOf(mobile as RegExpMatchArray)).toEqual([
      "Home",
      "Connect",
      "Activity",
      "Devices",
      "More",
    ]);
  });

  it("ADMIN_PAGE_ROUTES keeps the five console surfaces (the audit/reconciliation/projection rows cite them)", () => {
    const source = read("apps/admin/src/routes.ts");
    expect(constArrayKeys(source, "ADMIN_PAGE_ROUTES")).toEqual([
      "tenants",
      "audit",
      "reconciliation",
      "projectionHealth",
      "supportTriage",
    ]);
  });
});

/** Extracts the keys of a `Object.freeze({...} as const)` route table. */
function constArrayKeys(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\{([^}]*)\\}`));
  expect(match, `expected 'export const ${name} = Object.freeze({...}'`).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? "");
}

// --------------------------------------------------------------------------------
// Guard 2 — the inventory and the doc stay in lockstep
// --------------------------------------------------------------------------------

describe("RL-115 guard: the inventory, the doc and the recorded gaps stay in sync", () => {
  const TEST_FILE = "apps/web/test/rl115-capability-discoverability.test.ts";
  const DOC_FILE = "docs/capability-discoverability.md";

  it("both the suite and the doc exist", () => {
    mustExist(TEST_FILE);
    mustExist(DOC_FILE);
  });

  it("every capability id in the suite appears in the doc's verdict matrix (and vice versa)", () => {
    const testSource = read(TEST_FILE);
    const doc = read(DOC_FILE);
    const suiteIds = [...testSource.matchAll(/id: "(CAP-[A-Z0-9-]+)"/g)].map((m) => m[1] ?? "");
    expect(suiteIds.length, "the suite must define the frozen inventory").toBeGreaterThan(20);
    const docIds = [...doc.matchAll(/\|\s*(CAP-[A-Z0-9-]+)\s*\|/g)].map((m) => m[1] ?? "");
    for (const id of suiteIds) {
      expect(docIds, `${id} must have a doc matrix row`).toContain(id);
    }
    const uniqueSuite = [...new Set(suiteIds)].sort();
    expect(docIds.filter((id, i, all) => all.indexOf(id) === i).sort()).toEqual(uniqueSuite);
  });

  it("every row the suite marks GAP is recorded as a finding in the doc", () => {
    const testSource = read(TEST_FILE);
    const doc = read(DOC_FILE);
    // Extract the GAP id set from the suite (verdict: "GAP" rows).
    const gapIds = [...testSource.matchAll(/\{\s*\n\s*id: "(CAP-[A-Z0-9-]+)",[\s\S]{0,600}?verdict: "GAP"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(gapIds.length, "the audit records the candidate gaps").toBeGreaterThanOrEqual(6);
    for (const id of gapIds) {
      expect(doc, `${id} must appear in the doc's findings/matrix as GAP`).toContain(id);
    }
    for (const findingId of [
      "RL-115-F1",
      "RL-115-F2",
      "RL-115-F3",
      "RL-115-F4",
      "RL-115-F5",
      "RL-115-F6",
      "RL-115-F7",
      "RL-115-F8",
    ]) {
      expect(doc, `${findingId} finding record`).toContain(findingId);
    }
  });

  it("the doc carries the §15 verdict vocabulary and the four requirements", () => {
    const doc = read(DOC_FILE);
    for (const term of [
      "VERIFIED",
      "VERIFIED (proxy)",
      "GAP",
      "primary user-facing entry point",
      "contextual link",
      "explanatory view",
      "recovery/support path",
    ]) {
      expect(doc, `doc vocabulary: ${term}`).toContain(term);
    }
  });
});

// --------------------------------------------------------------------------------
// Guard 3 — the recorded ABSENCES stay truthful (the negative proofs)
// --------------------------------------------------------------------------------

describe("RL-115 guard: the recorded discoverability absences stay truthful", () => {
  it("no customer/admin/mobile surface source links the /ops/slo dashboard or names an SLO nav entry (CAP-SLO, RL-115-F2)", () => {
    for (const dir of ["apps/web/src", "apps/admin/src", "apps/mobile/src"]) {
      const joined = readDirJoined(dir);
      expect(joined, `${dir}: no /ops/slo reference`).not.toContain("/ops/slo");
      expect(joined, `${dir}: no SLO nav vocabulary`).not.toMatch(/label:\s*"[^"]*SLO[^"]*"/);
    }
    // The ops surface itself still exists (the view is real; the entry is not).
    mustExist("apps/portal-host/src/ops-slo-page.ts");
    expect(read("apps/portal-host/src/ops-slo-page.ts")).toContain('"data-slo-dashboard": "true"');
  });

  it("no customer web surface source carries eSIM management vocabulary (CAP-X-ESIM-MANAGE, RL-115-F1)", () => {
    const joined = readDirJoined("apps/web/src");
    expect(joined.toLowerCase()).not.toContain("esim");
    // The mobile surface carries the capability NAMES (status rows) but no
    // management affordance — its views add no eSIM management vocabulary.
    const mobileViews = read("apps/mobile/src/views.ts");
    expect(mobileViews).not.toMatch(/install[a-z]* button|activate profile|activation code/i);
  });

  it("the workspace renders connector STATUS but the app sources compose no connector-enrollment flow (RL-115-F3)", () => {
    const joined = readDirJoined("apps/web/src");
    // The honest status marker exists...
    expect(joined).toContain('data-connector-absent');
    // ...and no flow/route offers connector provisioning.
    expect(joined, "no connector enrollment flow in the web app").not.toMatch(
      /flows\/[a-z-]*connector[a-z-]*/,
    );
    expect(joined, "no provisionConnector command in the web app").not.toMatch(
      /provisionConnector|enrollConnector/,
    );
  });

  it("no commerce surface source composes a refund view or flow (CAP-B-REFUNDS, RL-115-F4)", () => {
    // The two surfaces that would carry a refund view (the §2 Layer B read
    // surfaces) carry none. (Other pages legitimately name the refund
    // SUPPORT-REF KIND in the closed recovery vocabulary — that is not a
    // refund view.)
    for (const file of ["apps/web/src/pages/commerce-page.ts", "apps/web/src/pages/order-journey-page.ts"]) {
      expect(read(file), `${file}: no refund view vocabulary`).not.toMatch(/[Rr]efund/);
    }
  });

  it("no surface source carries SSO/SCIM/MDM vocabulary (CAP-E-SSO-SCIM-MDM, RL-115-F5)", () => {
    for (const dir of ["apps/web/src", "apps/admin/src", "apps/mobile/src"]) {
      expect(readDirJoined(dir), `${dir}: no SSO/SCIM/MDM vocabulary`).not.toMatch(
        /\b(SSO|SCIM|MDM)\b/,
      );
    }
  });

  it("no integration/compatibility-health surface exists in the admin console (CAP-D-COMPAT, RL-115-F6)", () => {
    const adminPages = readDirJoined("apps/admin/src/pages");
    expect(adminPages.toLowerCase()).not.toContain("compat");
    expect(adminPages.toLowerCase()).not.toContain("integration health");
  });

  it("the commerce Orders table composes no order links and /orders stays URL-only (RL-115-F8)", () => {
    const commerce = read("apps/web/src/pages/commerce-page.ts");
    // The orders table body renders plain text cells — no pagePath("order").
    const ordersSection = commerce.slice(
      commerce.indexOf('pageHeading("Orders")'),
      commerce.indexOf('pageHeading("Subscriptions")'),
    );
    expect(ordersSection).not.toContain('pagePath("order"');
    expect(ordersSection).not.toContain("/orders/");
  });

  it("the /notifications compatibility page has no inbound link anywhere in the web sources (RL-114-F4)", () => {
    for (const file of readTsFiles("apps/web/src/pages")) {
      const source = read(file);
      expect(source, `${file}: no /notifications link`).not.toContain('pagePath("notifications")');
      expect(source, `${file}: no /notifications href`).not.toContain('href: "/notifications"');
    }
  });
});

// --------------------------------------------------------------------------------
// Guard 4 — the frozen vocabularies the matrix rows cite stay closed
// --------------------------------------------------------------------------------

describe("RL-115 guard: the §7 capability and §11 SLO vocabularies stay closed", () => {
  it("DEVICE_CAPABILITY_NAMES keeps the §7 vocabulary the matrix rows cite", () => {
    const names = constArray(
      read("packages/domain-experience/src/capability/device-capability-name.ts"),
      "DEVICE_CAPABILITY_NAMES",
    );
    expect(names).toEqual([
      "wifi_observation",
      "wifi_control",
      "cellular_data_sim_selection",
      "esim_profile_install",
      "esim_profile_remove",
      "esim_profile_enable",
      "active_interface_selection",
      "vpn_network_extension",
      "concurrent_interface_constraints",
      "radio_os_telemetry",
      "background_execution_limits",
    ]);
  });

  it("PRODUCT_SLO_IDS keeps the nine §11 SLOs the ops dashboard renders", () => {
    const ids = constArray(read("packages/observability/src/slo/slo-metrics.ts"), "PRODUCT_SLO_IDS");
    expect(ids).toHaveLength(9);
    expect(ids).toContain("time-to-usable-connectivity");
    expect(ids).toContain("support-incidents-attributable-to-connectivity-orchestration");
  });

  it("the ops SLO surface renders the §11 dashboard structure (the explanatory view stays real)", () => {
    const ops = read("apps/portal-host/src/ops-slo-page.ts");
    expect(ops).toContain('"data-slo-dashboard": "true"');
    expect(ops).toContain("Service level objectives");
    expect(ops).toContain("no-data (degraded)");
  });

  it("the recovery-path carrier keeps the closed support-ref vocabulary", () => {
    const kinds = constArray(read("apps/web/src/pages/support-context.ts"), "SUPPORT_REF_KINDS");
    expect(kinds).toEqual([
      "order",
      "subscription",
      "payment",
      "invoice",
      "refund",
      "connectivity_reference",
      "experience_intent",
      "device",
      "notification",
    ]);
  });
});

// --------------------------------------------------------------------------------
// File-walking helpers (structure-only; nothing is imported)
// --------------------------------------------------------------------------------

function readTsFiles(dir: string): string[] {
  const base = join(REPO_ROOT, dir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...readTsFiles(`${dir}/${entry.name}`));
    else if (/\.ts$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
  }
  return out;
}

function readDirJoined(dir: string): string {
  return readTsFiles(dir)
    .map((file) => read(file))
    .join("\n");
}
