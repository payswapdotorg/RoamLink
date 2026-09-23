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
 *  - the recorded ABSENCES (refund surface, compatibility health
 *    surface, /notifications inbound links) stay truthful — if one of
 *    these tests FAILS because a surface changed, the inventory + doc
 *    MUST be updated in the same change;
 *  - FLIPPED ABSENCES: PA-001 requires the eSIM management vocabulary on
 *    the customer web surface (the flipped presence guard below — the
 *    mobile surface stays status-only until its own work order); PA-003
 *    requires the Orders-table journey composition (through the route
 *    table) and resolves /notifications as the designed Option B contract
 *    (compatibility-only: zero inbound links BY DESIGN, plus the visible
 *    compatibility-role note on the page itself); PA-06 requires the
 *    connector-enrollment guided action to stay composed through the app
 *    contract and never through enterprise domain machinery imported into
 *    the web app; PA-009 requires the admin console's "SLO health" nav
 *    entry to the host's session-gated /ops/slo surface (the customer
 *    web/mobile surfaces stay SLO-free BY DESIGN — §13: admin and
 *    diagnostics are not customer navigation); PA-007 requires the
 *    workspace policy summary to stay composed from the app contract's
 *    READ-ONLY organization policy read — the absence states stay explicit
 *    contract states and the surface composes no policy write affordance
 *    (policy is organization-level configuration managed upstream);
 *    PA-008 requires the workspace's enterprise integrations surface to
 *    stay composed from the app contract's READ-ONLY integrations read —
 *    the SSO/SCIM/MDM statuses render with EXACTLY the four honest states
 *    (configured / not-configured / unavailable / unknown; `unavailable`
 *    is the missing-backend-contract declaration), the surface composes NO
 *    configuration affordance (no OAuth dance, no SCIM endpoint fields,
 *    no MDM enrollment forms), and the admin/mobile surfaces stay
 *    integration-vocabulary-free until their own work orders.
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
    // PA-06 closed RL-115-F3 (CAP-E-CONNECTOR-ENROLLMENT): the GAP count
    // went 6 -> 5; PA-009 closed RL-115-F2 (CAP-SLO): 5 -> 4; PA-007
    // closed RL-115-F7 (CAP-E-POLICY): 4 -> 3; PA-008 closed RL-115-F5
    // (CAP-E-SSO-SCIM-MDM): 3 -> 2 (the remaining gaps: refunds F4 and
    // compatibility F6 - F8 stays VERIFIED(proxy)).
    expect(gapIds.length, "the audit records the candidate gaps").toBeGreaterThanOrEqual(2);
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
  it("the admin console links the /ops/slo dashboard and names the SLO health nav entry; the customer surfaces stay SLO-free (CAP-SLO, RL-115-F2 closed by PA-009)", () => {
    // PA-009 closed RL-115-F2: the admin console nav carries the §13 "SLO
    // health" entry pointing at the HOST's session-gated /ops/slo surface
    // (RL-109 — the dashboard itself is unchanged). The customer surfaces
    // (web + mobile) stay SLO-free BY DESIGN: §13 keeps admin and
    // diagnostics out of customer navigation.
    for (const dir of ["apps/web/src", "apps/mobile/src"]) {
      const joined = readDirJoined(dir);
      expect(joined, `${dir}: no /ops/slo reference`).not.toContain("/ops/slo");
      expect(joined, `${dir}: no SLO nav vocabulary`).not.toMatch(/label:\s*"[^"]*SLO[^"]*"/);
    }
    // The admin console now carries BOTH the path reference (the named
    // route constant in apps/admin/src/routes.ts) and the nav label.
    const admin = readDirJoined("apps/admin/src");
    expect(admin, "the admin nav links the ops route").toContain("/ops/slo");
    expect(admin, "the admin nav names SLO health").toMatch(/label:\s*"[^"]*SLO[^"]*"/);
    // The ops surface itself still exists (the view is real; the entry points at it).
    mustExist("apps/portal-host/src/ops-slo-page.ts");
    expect(read("apps/portal-host/src/ops-slo-page.ts")).toContain('"data-slo-dashboard": "true"');
  });

  it("the customer web surface carries the eSIM management journey vocabulary (CAP-X-ESIM-MANAGE, RL-115-F1 flipped by PA-001)", () => {
    const joined = readDirJoined("apps/web/src");
    // The flipped absence: the web surface NOW carries the closed eSIM
    // capability names (the journey page's truth table), the dedicated
    // route, and the three command flows. The mobile matrix stays the
    // per-capability truth table owner (its own work order owns its journey).
    expect(joined).toContain("esim_profile_install");
    expect(joined).toContain("esim_profile_remove");
    expect(joined).toContain("esim_profile_enable");
    expect(joined).toContain('deviceSim: "/devices/{deviceId}/sim"');
    expect(joined).toContain("installEsimProfileFlow");
    expect(joined).toContain("removeEsimProfileFlow");
    expect(joined).toContain("enableEsimProfileFlow");
    // The mobile surface still carries the capability NAMES (status rows) but
    // no management affordance — its views add no eSIM management vocabulary.
    const mobileViews = read("apps/mobile/src/views.ts");
    expect(mobileViews).not.toMatch(/install[a-z]* button|activate profile|activation code/i);
  });

  it("the workspace composes the guided connector-enrollment flow through the app contract (RL-115-F3, closed by PA-06)", () => {
    const joined = readDirJoined("apps/web/src");
    // The honest status marker still exists...
    expect(joined).toContain('data-connector-absent');
    // ...and the guided action now EXISTS: the connector journey step links
    // the flow, the flow renders its stages from the read model, and the
    // ONLY writer is the wired /flows/provision-connector command form
    // (the host binds it to the app's provisionConnectorFlow).
    expect(joined).toContain('"data-connector-enrollment"');
    expect(joined).toContain('"data-flow": "provision-connector"');
    expect(joined).toContain("/flows/provision-connector");
    expect(joined).toContain("provisionConnectorFlow");
    // THE AUTHORITY FENCE (PA-06 MUST NOT): the web app composes NO
    // enrollment state machine of its own - no enterprise domain
    // machinery is imported or re-implemented (the enterprise package's
    // transition machinery owns every state change; the page derives its
    // step/flow views purely from the app-kit mirrored reads).
    expect(joined, "no enterprise domain machinery in the web app").not.toMatch(
      /applyConnectorProvisioningTransition|negotiateConnectorProvisioning|CONNECTOR_PROVISIONING_STATES/,
    );
    expect(joined, "no direct enterprise package import").not.toContain('from "@roamlink/enterprise"');
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

  it("the workspace composes the enterprise integrations surface through the app contract's READ-ONLY read (RL-115-F5, closed by PA-008)", () => {
    // PA-008 closed RL-115-F5: the customer web surface NOW carries the
    // SSO/SCIM/MDM vocabulary — the workspace's Enterprise integrations
    // section, composed from the app contract's mirrored integrations read
    // (never a direct enterprise dependency, never a redefined state). The
    // admin and mobile surfaces stay integration-vocabulary-free until
    // their own work orders (the original pin's scope, preserved for the
    // surfaces this work order does not own).
    const joined = readDirJoined("apps/web/src");
    expect(joined, "the integration vocabulary renders on the web surface").toMatch(
      /\b(SSO|SCIM|MDM)\b/,
    );
    expect(joined, "the integrations section marker").toContain('"data-integrations"');
    expect(joined, "the per-integration state markers").toContain('"data-integration-state"');
    expect(joined, "the honest missing-backend-contract explanation").toContain(
      "requires the enterprise integration API",
    );
    expect(joined, "the section derives from the mirrored read").toContain(
      "deriveIntegrationRows",
    );
    expect(joined, "the rows ride the mirrored kind vocabulary").toContain(
      "ENTERPRISE_INTEGRATION_RESOURCE_KINDS",
    );
    expect(joined, "the settings page carries the contextual link").toContain(
      'href: "/workspace#integrations"',
    );
    // THE NO-FABRICATION FENCE (PA-008 MUST NOT): the integrations section
    // composes NO configuration affordance — no OAuth dance, no SCIM
    // endpoint fields, no MDM enrollment forms — because no write contract
    // backs them. The section source slice must carry no form, button or
    // command flow, and the web app composes no integration write flow
    // anywhere.
    const workspacePage = read("apps/web/src/pages/workspace-page.ts");
    const sectionSource = workspacePage.slice(
      workspacePage.indexOf("function integrationsSection"),
      workspacePage.indexOf("function deviceFleetSection"),
    );
    expect(sectionSource, "the integrations section composes no form").not.toMatch(
      /<form|el\(\s*"form"|el\(\s*"button"|"button"|data-flow|type="password"|<input|el\(\s*"input"/,
    );
    expect(joined, "no integration write affordance").not.toMatch(
      /data-flow="(configure|setup|enroll|provision|connect|enable|disable)-(sso|scim|mdm|integration)/,
    );
    // THE AUTHORITY FENCE (the same fence the connector/policy flows
    // guard): the web app imports NO enterprise domain machinery.
    expect(joined, "no direct enterprise package import").not.toContain('from "@roamlink/enterprise"');
    // The admin and mobile surfaces stay integration-vocabulary-free
    // (their own work orders own any future surfaces).
    for (const dir of ["apps/admin/src", "apps/mobile/src"]) {
      expect(readDirJoined(dir), `${dir}: no SSO/SCIM/MDM vocabulary yet`).not.toMatch(
        /\b(SSO|SCIM|MDM)\b/,
      );
    }
  });

  it("no integration/compatibility-health surface exists in the admin console (CAP-D-COMPAT, RL-115-F6)", () => {
    const adminPages = readDirJoined("apps/admin/src/pages");
    expect(adminPages.toLowerCase()).not.toContain("compat");
    expect(adminPages.toLowerCase()).not.toContain("integration health");
  });

  it("the workspace composes the policy summary from the app contract's READ-ONLY policy read (RL-115-F7, closed by PA-007)", () => {
    // PA-007 closed RL-115-F7: the organization policy READ MODEL rides
    // the app contract (the mirrored state/source vocabularies,
    // drift-guarded in wave4-a) and the workspace page renders the
    // promised summary section from it - with the EXPLICIT absence states
    // (never a UI shrug) and the freshness pairing. THE AUTHORITY FENCE:
    // the surface stays READ-ONLY - no policy command, editor or write
    // vocabulary (policy is organization-level configuration managed
    // upstream; the enterprise package's policy module owns parse +
    // vocabularies ONLY).
    const workspacePage = read("apps/web/src/pages/workspace-page.ts");
    expect(workspacePage, "the summary section composes from the read model").toContain(
      "derivePolicySummary",
    );
    expect(workspacePage, "the section renders its state marker").toContain("data-policy-summary");
    expect(workspacePage, "the authority note names where management lives").toContain(
      '"data-policy-authority": "true"',
    );
    expect(workspacePage, "the recovery note stays reachable").toContain(
      '"data-policy-support-reachability": "true"',
    );
    // THE FLIP: the old gap marker (the page's own honest shrug) is gone
    // from the page source - the summary is real now.
    expect(workspacePage).not.toContain("data-policy-gap");
    // READ-ONLY: no policy write affordance is composed anywhere on the
    // web surface, and the web app still imports NO enterprise domain
    // machinery (the same fence the connector flow guards).
    const joined = readDirJoined("apps/web/src");
    expect(joined, "no policy write affordance").not.toMatch(
      /data-flow="(edit|update|set|create|delete)-policy"/,
    );
    expect(joined, "no direct enterprise package import").not.toContain('from "@roamlink/enterprise"');
  });

  it("the commerce Orders table composes its delivery-progress journey links through the route table (RL-115-F8, closed by PA-003)", () => {
    const commerce = read("apps/web/src/pages/commerce-page.ts");
    // PA-003 closed RL-115-F8: every Orders-table row composes its journey
    // link through the route table (pagePath("order", ...)) — never a
    // hand-written /orders/ path — so the delivery-progress view is
    // reachable from the commerce surface, not URL-only.
    const ordersSection = commerce.slice(
      commerce.indexOf('pageHeading("Orders")'),
      commerce.indexOf('pageHeading("Subscriptions")'),
    );
    expect(ordersSection, "every row composes pagePath(\"order\")").toContain('pagePath("order"');
    expect(ordersSection, "no hand-written /orders/ path").not.toContain('"/orders/');
  });

  it("the /notifications compatibility-only contract holds (RL-114-F4, resolved Option B by PA-003): zero inbound links by design + the visible compatibility-role note", () => {
    // The designed contract (PA-003, Option B): Activity is the SOLE
    // user-facing notification surface; /notifications is EXPLICITLY
    // compatibility-only. Zero inbound links is BY DESIGN — no page source
    // may compose a link to it.
    for (const file of readTsFiles("apps/web/src/pages")) {
      const source = read(file);
      expect(source, `${file}: no /notifications link`).not.toContain('pagePath("notifications")');
      expect(source, `${file}: no /notifications href`).not.toContain('href: "/notifications"');
    }
    // The compatibility surface states its own role and links the live
    // narrative (the render-level pins live in rl114-extended-a11y and
    // the rl115 closure probes; this is the structural half).
    const notifications = read("apps/web/src/pages/notifications-page.ts");
    expect(notifications, "the compatibility-role note exists").toContain('data-compatibility-role');
    expect(notifications, "the note links the live narrative").toContain('pagePath("activity")');
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
