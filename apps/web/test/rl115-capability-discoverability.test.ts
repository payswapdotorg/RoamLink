/**
 * RL-115 — the capability-discoverability cross-reference suite (web surface).
 *
 * spec/ux-architecture.md §15: "Every capability in the frozen architecture
 * must have: one primary user-facing entry point; one contextual link from
 * the journey where it becomes relevant; one explanatory view; one
 * recovery/support path." And spec/user-journey-audit.md line 199: "A
 * capability is not considered discoverable merely because an API or page
 * exists."
 *
 * This suite is the EXECUTABLE half of the audit: a FROZEN capability
 * inventory mirrored from spec/architecture.md §2..§11 (every row carries
 * its spec citation) is checked against the RENDERED customer surfaces for
 * the four §15 requirements. The companion matrix — verdicts, findings and
 * minimal reproducers — lives in docs/capability-discoverability.md; the
 * structural drift-guards over this inventory live in
 * tests/architecture/test/wave8-b-capability-guards.test.ts.
 *
 * VERIFICATION-ONLY DISCIPLINE (threat-model-verification.md precedent):
 * findings are RECORDED as pinned assertions over current observable
 * behavior (verdict + minimal reproducer in the doc); no src file is
 * touched by this work item. Verdict vocabulary: VERIFIED (render-level
 * proof on this tree), VERIFIED(proxy) (the strongest render/structural
 * proxy — used for the mobile/admin/ops-owned surfaces verified from this
 * suite's sibling suites and the structural guards), GAP (pinned absence).
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp, DESKTOP_NAV, MOBILE_NAV } from "../src/app.js";
import { WEB_PAGE_ROUTES } from "../src/routes.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEEDED_INTENT_ID = "cccccccc-0000-4000-8000-000000000001";
const CASE_ID = "cafecafe-0000-4000-8000-000000000001";

function buildApp(options?: { readonly seed?: FakeApiSeed }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  return { app: new CustomerWebApp({ client }), client, fake, clock };
}

/** The honest empty world (first-run customer). */
function freshCustomerSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    devices: [],
    intents: [],
    notifications: [],
    orders: [],
    subscriptions: [],
    payments: [],
    invoices: [],
    references: [],
    supportCases: [],
  };
  return { ...seed, tenants };
}

// --------------------------------------------------------------------------------
// The frozen capability inventory (spec/architecture.md §2..§11, mirrored)
// --------------------------------------------------------------------------------

export type DiscoverabilityVerdict = "VERIFIED" | "VERIFIED(proxy)" | "GAP";

export interface CapabilityRow {
  readonly id: string;
  readonly capability: string;
  /** The frozen architecture section this row mirrors. */
  readonly spec: string;
  readonly verdict: DiscoverabilityVerdict;
  /**
   * VERIFIED rows: the primary entry point's page and the strings that must
   * render there (the render-level proof the entry exists AND is the
   * capability's surface, not merely a route).
   */
  readonly entry?: { readonly page: Parameters<CustomerWebApp["renderDocument"]>[0]["page"]; readonly mustRender: readonly string[] };
  /** VERIFIED rows: a contextual link that must exist on the journey page. */
  readonly contextualLink?: { readonly from: Parameters<CustomerWebApp["renderDocument"]>[0]["page"]; readonly href: string; readonly labelContains: string };
  /** VERIFIED rows: the explanatory view and its evidence. */
  readonly explanatoryView?: { readonly page: Parameters<CustomerWebApp["renderDocument"]>[0]["page"]; readonly mustRender: readonly string[] };
  /** VERIFIED rows: the recovery/support path and its evidence. */
  readonly recovery?: { readonly page: Parameters<CustomerWebApp["renderDocument"]>[0]["page"]; readonly mustRender: readonly string[] };
  /** GAP rows: what the absence probe must assert. */
  readonly gapNote?: string;
}

/**
 * THE INVENTORY. Frozen against spec/architecture.md; the drift-guards in
 * tests/architecture pin this id set against docs/capability-discoverability.md.
 */
export const RL115_CAPABILITY_INVENTORY: readonly CapabilityRow[] = [
  // ---- Layer A — Experience Domain (spec/architecture.md §2) --------------
  {
    id: "CAP-A-ACCOUNTS",
    capability: "User and organization accounts",
    spec: "spec/architecture.md §2 Layer A",
    verdict: "VERIFIED",
    entry: { page: "settings", mustRender: ["Settings", "Signed in as", "Workspace"] },
    contextualLink: { from: "more", href: "/settings", labelContains: "Settings" },
    explanatoryView: { page: "settings", mustRender: ["Your account"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
  },
  {
    id: "CAP-A-DEVICE-REGISTRY",
    capability: "Device registry and capability/context snapshots",
    spec: "spec/architecture.md §2 Layer A; §9 (devices page)",
    verdict: "VERIFIED",
    entry: { page: "devices", mustRender: ["Devices", "What it can do"] },
    contextualLink: { from: "home", href: "/devices", labelContains: "Manage devices" },
    explanatoryView: { page: "device", mustRender: ["What this device can do", "Capability evidence"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
  },
  {
    id: "CAP-A-GOALS",
    capability: "Human-facing preferences and ExperienceIntent (Goals)",
    spec: "spec/architecture.md §2 Layer A; §3 (intent model)",
    verdict: "VERIFIED",
    entry: { page: "intents", mustRender: ["Goals"] },
    contextualLink: { from: "home", href: "/intents", labelContains: "Review your goal" },
    explanatoryView: { page: "intent", mustRender: ["What you asked for", "What RoamLink derived from your goal", "What changed"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
  },
  {
    id: "CAP-A-NOTIFICATIONS",
    capability: "Notifications (represented in Activity; dedicated route kept)",
    spec: "spec/architecture.md §2 Layer A; spec/ux-architecture.md §8",
    verdict: "VERIFIED(proxy)",
    entry: { page: "activity", mustRender: ["Activity", "Needs your attention"] },
    contextualLink: { from: "home", href: "/activity", labelContains: "Open Activity" },
    explanatoryView: { page: "activity", mustRender: ["What RoamLink did"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
    gapNote:
      "proxy: the /notifications page itself has zero inbound links (RL-114-F4, URL-only compatibility surface per spec §8); Activity is the discoverable notification surface",
  },
  {
    id: "CAP-A-SUPPORT",
    capability: "Support and explainability carrier",
    spec: "spec/architecture.md §2 Layer A; spec/ux-architecture.md §11",
    verdict: "VERIFIED",
    entry: { page: "support", mustRender: ["Support", "Open a support case"] },
    contextualLink: { from: "connectivity", href: "/support", labelContains: "Get help with this" },
    explanatoryView: { page: "case", mustRender: ["Customer thread"] },
    recovery: { page: "support", mustRender: ["Nothing is attached automatically from this form."] },
  },
  {
    id: "CAP-A-EXPLAINABILITY",
    capability: "Explainability: why / evidence / freshness (progressive disclosure)",
    spec: "spec/architecture.md §2 Layer A; spec/ux-architecture.md §6",
    verdict: "VERIFIED",
    entry: { page: "connectivity", mustRender: ["Connectivity", "Your connection journey"] },
    contextualLink: { from: "home", href: "/connectivity", labelContains: "See the full connectivity read" },
    explanatoryView: { page: "connectivity", mustRender: ['data-disclosure="why"', 'data-disclosure="evidence"', 'data-disclosure="technical"'] },
    recovery: { page: "connectivity", mustRender: ["Get help with this"] },
  },

  // ---- Layer B — RoamLink Commerce (spec/architecture.md §2) --------------
  {
    id: "CAP-B-CATALOG",
    capability: "Product catalog and customer-facing offers",
    spec: "spec/architecture.md §2 Layer B",
    verdict: "VERIFIED",
    entry: { page: "commerce", mustRender: ["Plans &amp; Billing", "Place an order"] },
    contextualLink: { from: "more", href: "/commerce", labelContains: "Plans &amp; Billing" },
    explanatoryView: { page: "commerce", mustRender: ["never implies connectivity delivery"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
  },
  {
    id: "CAP-B-ORDERS",
    capability: "Orders, subscriptions and customer entitlements",
    spec: "spec/architecture.md §2 Layer B; §4 commercial loop",
    verdict: "VERIFIED(proxy)",
    entry: { page: "order", mustRender: ["Your delivery progress"] },
    explanatoryView: { page: "order", mustRender: ["Commercial facts (separate)", "Order connectivity journey"] },
    recovery: { page: "order", mustRender: ["Get help with this"] },
    gapNote:
      "proxy: the delivery-progress view renders and the entry exists, but NO in-page link reaches it — the commerce Orders table renders plain rows (no anchors) and the route is composed by the host's post-payment redirect (RL-115-F8)",
  },
  {
    id: "CAP-B-PAYMENTS-INVOICES",
    capability: "Customer-facing payment state, invoices, pricing presentation",
    spec: "spec/architecture.md §2 Layer B; §10 (billable finality)",
    verdict: "VERIFIED",
    entry: { page: "order", mustRender: ["Commercial facts (separate)", "Invoices"] },
    contextualLink: { from: "order", href: "/commerce", labelContains: "Plans &amp; Billing" },
    explanatoryView: { page: "order", mustRender: ["payment"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
  },
  {
    id: "CAP-B-REFUNDS",
    capability: "Refunds",
    spec: "spec/architecture.md §2 Layer B ('customer-facing payment state, invoices, refunds')",
    verdict: "GAP",
    gapNote:
      "the domain owns refunds and the support-ref vocabulary carries the kind, but NO rendered surface exposes refund state — not even a read view",
  },

  // ---- Layer C — RoamLink Edge (spec/architecture.md §2) ------------------
  {
    id: "CAP-C-OBSERVATION",
    capability: "Device-side observation and context collection",
    spec: "spec/architecture.md §2 Layer C",
    verdict: "VERIFIED",
    entry: { page: "device", mustRender: ["What connectivity it has now"] },
    contextualLink: { from: "device", href: "/connectivity", labelContains: "See the full connectivity journey" },
    explanatoryView: { page: "connectivity", mustRender: ["Device observations"] },
    recovery: { page: "device", mustRender: ["See the full connectivity journey"] },
  },
  {
    id: "CAP-C-OFFLINE-OUTBOX",
    capability: "Durable intent/sync outbox; graceful offline operation",
    spec: "spec/architecture.md §2 Layer C",
    verdict: "VERIFIED(proxy)",
    entry: { page: "more", mustRender: ["More"] },
    explanatoryView: { page: "more", mustRender: ["Workspace"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
    gapNote:
      "proxy: the outbox surface is the MOBILE edge shell (apps/mobile Outbox leg — rendered and asserted in apps/mobile/test/rl115-mobile-capability-surface.test.ts); the customer web surface has no offline view (it is a hosted surface)",
  },
  {
    id: "CAP-C-READ-MODEL",
    capability: "Current connectivity read model for UX",
    spec: "spec/architecture.md §2 Layer C",
    verdict: "VERIFIED",
    entry: { page: "connectivity", mustRender: ["Usefully connected", "Your connection journey"] },
    contextualLink: { from: "home", href: "/connectivity", labelContains: "See the full connectivity read" },
    explanatoryView: { page: "overview", mustRender: ["Your connectivity, honestly"] },
    recovery: { page: "connectivity", mustRender: ["What you can do"] },
  },

  // ---- Layer D + §6 reconciliation (spec/architecture.md §2, §6) ----------
  {
    id: "CAP-D-RECONCILIATION",
    capability: "Reconciliation engine (durable admit, dedupe, repair, honest stale)",
    spec: "spec/architecture.md §2 Layer D; §6 musts",
    verdict: "VERIFIED(proxy)",
    entry: { page: "connectivity", mustRender: ["What RoamLink is waiting for"] },
    contextualLink: { from: "more", href: "/workspace", labelContains: "Workspace" },
    explanatoryView: { page: "connectivity", mustRender: ["observed", "stale"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
    gapNote:
      "proxy: the operator-side view is the admin console Reconciliation page (structural guard in tests/architecture); the customer-facing effect (honest unknown/stale, never guessed) is what renders here — an unavailable read renders the shell indicator's 'Cannot confirm right now', never a status",
  },
  {
    id: "CAP-D-PROJECTIONS",
    capability: "Projection of ADCOS state into read models (disposable, fresh-stamped)",
    spec: "spec/architecture.md §2 Layer D; §5 projection record fields",
    verdict: "VERIFIED(proxy)",
    entry: { page: "connectivity", mustRender: ["Evidence class", "Canonical resource"] },
    contextualLink: { from: "order", href: "/connectivity", labelContains: "Connectivity" },
    explanatoryView: { page: "connectivity", mustRender: ["observed", "Payload digest"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
    gapNote:
      "proxy: §5's record fields render through the evidence disclosure (class, canonical record, source version, observed/received, freshness); the operator projection-health view is the admin console page (structural guard)",
  },
  {
    id: "CAP-D-COMPAT",
    capability: "Compatibility checks against the supported ADCOS API contract",
    spec: "spec/architecture.md §2 Layer D; spec/ux-architecture.md §13 (integration/compatibility health)",
    verdict: "GAP",
    gapNote:
      "the env-gated compatibility probe runs host-side (RL-108) but NO rendered surface exposes integration/compatibility health — the admin console has no such page and §13 expects one",
  },

  // ---- §4 control loops (spec/architecture.md §4) --------------------------
  {
    id: "CAP-L-DESIRED",
    capability: "Desired-state loop (User/Policy -> ExperienceIntent -> compile -> projection)",
    spec: "spec/architecture.md §4",
    verdict: "VERIFIED",
    entry: { page: "onboarding", mustRender: ["Welcome to RoamLink"] },
    contextualLink: { from: "home", href: "/intents", labelContains: "Review your goal" },
    explanatoryView: { page: "intent", mustRender: ["What RoamLink derived from your goal"] },
    recovery: { page: "intent", mustRender: ["What you can do"] },
  },
  {
    id: "CAP-L-RECOVERY",
    capability: "Recovery loop (observation -> reconcile -> recompile -> ADCOS)",
    spec: "spec/architecture.md §4",
    verdict: "VERIFIED",
    entry: { page: "activity", mustRender: ["Automation status"] },
    contextualLink: { from: "home", href: "/activity", labelContains: "See what RoamLink did" },
    explanatoryView: { page: "activity", mustRender: ["What RoamLink did", "Needs your attention"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
  },
  {
    id: "CAP-L-COMMERCIAL",
    capability: "Commercial loop (order/payment -> entitlement -> delivery evidence -> billing)",
    spec: "spec/architecture.md §4; spec/user-journey-audit.md §6",
    verdict: "VERIFIED(proxy)",
    entry: { page: "order", mustRender: ["Your delivery progress"] },
    explanatoryView: { page: "order", mustRender: ["Command pipeline", "Commercial facts (separate)"] },
    recovery: { page: "order", mustRender: ["Get help with this"] },
    gapNote:
      "proxy: same contextual-link absence as CAP-B-ORDERS (RL-115-F8) — the loop's explanatory view is URL-only from the static surface",
  },

  // ---- §7 device capability matrix (the 8 bullets, 11 closed names) -------
  {
    id: "CAP-X-WIFI",
    capability: "Wi-Fi observation/control (wifi_observation, wifi_control)",
    spec: "spec/architecture.md §7; packages/domain-experience DEVICE_CAPABILITY_NAMES",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What this device can do"] },
    explanatoryView: { page: "device", mustRender: ["Automation levels explained"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote:
      "proxy: the per-capability truth table (status/evidence/freshness/gate) is the MOBILE capability matrix; the web device card carries verification freshness + automation levels, not per-capability rows",
  },
  {
    id: "CAP-X-SIM-SELECT",
    capability: "Cellular data-SIM selection (cellular_data_sim_selection)",
    spec: "spec/architecture.md §7",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What this device can do"] },
    explanatoryView: { page: "device", mustRender: ["Automation levels explained"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote:
      "proxy: covered only by the generic capability-gating mechanism (mobile matrix renders platform-reported rows); no dedicated SIM-selection UX anywhere",
  },
  {
    id: "CAP-X-ESIM-MANAGE",
    capability: "eSIM profile installation/removal/enablement (esim_profile_install/remove/enable)",
    spec: "spec/architecture.md §7",
    verdict: "GAP",
    gapNote:
      "status visibility is proven on the mobile truth table (all three eSIM capability names render with status/evidence/freshness/gate previews), but the rows are STATUS-ONLY: no anchor, form or button exists — there is no install/remove/enable flow, no profile inventory view, no activation-code entry, and the customer web surface has zero eSIM vocabulary (RL-115-F1)",
  },
  {
    id: "CAP-X-INTERFACE-SELECT",
    capability: "Active interface selection (active_interface_selection)",
    spec: "spec/architecture.md §7",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What this device can do"] },
    explanatoryView: { page: "device", mustRender: ["Automation levels explained"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote: "proxy: generic capability-gating mechanism only; no dedicated interface-selection UX",
  },
  {
    id: "CAP-X-VPN",
    capability: "VPN/network-extension operation (vpn_network_extension)",
    spec: "spec/architecture.md §7",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What this device can do"] },
    explanatoryView: { page: "device", mustRender: ["Automation levels explained"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote: "proxy: generic capability-gating mechanism only; no dedicated VPN-operation UX",
  },
  {
    id: "CAP-X-CONCURRENT",
    capability: "Concurrent-interface constraints (concurrent_interface_constraints)",
    spec: "spec/architecture.md §7",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What this device can do"] },
    explanatoryView: { page: "device", mustRender: ["Automation levels explained"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote: "proxy: generic capability-gating mechanism only; constraints render as gate decisions",
  },
  {
    id: "CAP-X-TELEMETRY",
    capability: "Radio/OS telemetry (radio_os_telemetry)",
    spec: "spec/architecture.md §7",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What connectivity it has now"] },
    explanatoryView: { page: "connectivity", mustRender: ["Device observations"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote: "proxy: observations/freshness render per device; no telemetry-specific UX",
  },
  {
    id: "CAP-X-BACKGROUND",
    capability: "Background execution limits (background_execution_limits)",
    spec: "spec/architecture.md §7",
    verdict: "VERIFIED(proxy)",
    entry: { page: "device", mustRender: ["What this device can do"] },
    explanatoryView: { page: "device", mustRender: ["Automation levels explained"] },
    recovery: { page: "device", mustRender: ["When RoamLink cannot do it for you"] },
    gapNote:
      "proxy: surfaced as the closed gate-reason vocabulary + manual guidance on mobile; no dedicated UX",
  },

  // ---- §8 enterprise model -------------------------------------------------
  {
    id: "CAP-E-WORKSPACE",
    capability: "Enterprise workspace model (switcher, org overview, fleet, goals, audit note)",
    spec: "spec/architecture.md §8; spec/ux-architecture.md §12",
    verdict: "VERIFIED",
    entry: { page: "workspace", mustRender: ["Workspace", "Organization connectivity", "Device fleet", "Active goals"] },
    contextualLink: { from: "settings", href: "/workspace", labelContains: "Open your workspace" },
    explanatoryView: { page: "workspace", mustRender: ["Your workspace journey"] },
    recovery: { page: "workspace", mustRender: ["Get help with this"] },
  },
  {
    id: "CAP-E-ONBOARDING",
    capability: "Guided enterprise onboarding journey (workspace -> ... -> live overview)",
    spec: "spec/architecture.md §8; spec/tech-lead-handoff.md §11",
    verdict: "VERIFIED",
    entry: { page: "workspace", mustRender: ['data-workspace-journey="true"'] },
    contextualLink: { from: "more", href: "/workspace", labelContains: "Workspace" },
    explanatoryView: { page: "workspace", mustRender: ["Organization verification", "Capability verification"] },
    recovery: { page: "workspace", mustRender: ["Support"] },
  },
  {
    id: "CAP-E-POLICY",
    capability: "Organization-level policies and policy summary",
    spec: "spec/architecture.md §8; spec/ux-architecture.md §12 (policy summary)",
    verdict: "GAP",
    gapNote:
      "the workspace page honestly renders the not-available state (no org-policy read model exists); there is no policy view AND no management path — the gap is the page's own recorded honest state",
  },
  {
    id: "CAP-E-CONNECTOR-ENROLLMENT",
    capability: "Optional enterprise connector (enrollment/provisioning as a user task)",
    spec: "spec/architecture.md §8; spec/ux-architecture.md §12 (connector/enrollment status)",
    verdict: "GAP",
    gapNote:
      "the workspace renders connector STATUS ('No connector has been set up yet.', journey step 'Not started') but offers NO action to enroll/provision one — the enterprise package's API machinery has no user-facing entry point (RL-115-F3)",
  },
  {
    id: "CAP-E-SSO-SCIM-MDM",
    capability: "SSO/SCIM/MDM integrations",
    spec: "spec/architecture.md §8",
    verdict: "GAP",
    gapNote: "zero UX vocabulary for SSO/SCIM/MDM on any surface (web, mobile, admin)",
  },
  {
    id: "CAP-E-AUDIT",
    capability: "Organization audit trail",
    spec: "spec/architecture.md §8; spec/ux-architecture.md §13",
    verdict: "VERIFIED(proxy)",
    entry: { page: "workspace", mustRender: ["Activity and audit"] },
    contextualLink: { from: "workspace", href: "/activity", labelContains: "Open Activity" },
    explanatoryView: { page: "workspace", mustRender: ["admin operations surface"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
    gapNote:
      "proxy: the customer workspace points at the Activity narrative and names the admin ops surface; the audit view itself is the admin console Audit page (structural guard)",
  },

  // ---- §10 failure semantics ----------------------------------------------
  {
    id: "CAP-S-FAILURE-STATES",
    capability: "Failure semantics: the separated lifecycle states incl. unknown/stale",
    spec: "spec/architecture.md §10",
    verdict: "VERIFIED",
    entry: { page: "connectivity", mustRender: ["Your connection journey"] },
    contextualLink: { from: "order", href: "/connectivity", labelContains: "Connectivity" },
    explanatoryView: { page: "order", mustRender: ["Order connectivity journey", "Subscription connectivity journey"] },
    recovery: { page: "support", mustRender: ["Open a support case"] },
  },

  // ---- §11 the nine SLOs ----------------------------------------------------
  {
    id: "CAP-SLO",
    capability: "SLO health: the nine §11 product SLOs",
    spec: "spec/architecture.md §11; spec/ux-architecture.md §13 (SLO health)",
    verdict: "GAP",
    gapNote:
      "the host-side ops dashboard at /ops/slo renders all nine §11 rows (real recorder state, RL-109), but NO surface links to it: the admin console nav has no SLO entry and the URL is the only path — discoverable only by knowing it (RL-115-F2)",
  },
];

// --------------------------------------------------------------------------------
// The §15 checks over the rendered surface
// --------------------------------------------------------------------------------

describe("RL-115 §15.1 primary entry points (render-level)", () => {
  it("every VERIFIED row's entry page renders its capability evidence", async () => {
    const { app } = buildApp();
    const cache = new Map<string, string>();
    const doc = async (page: CapabilityRow["entry"] extends undefined ? never : NonNullable<CapabilityRow["entry"]>["page"]): Promise<string> => {
      const hit = cache.get(page);
      if (hit !== undefined) return hit;
      const params =
        page === "device" ? { deviceId: PHONE_ID } :
        page === "intent" ? { intentId: SEEDED_INTENT_ID } :
        page === "order" ? { orderId: SEED_ORDER_ID } :
        page === "case" ? { caseId: CASE_ID } :
        undefined;
      const html = await app.renderDocument({ page, ...(params !== undefined ? { params } : {}) });
      cache.set(page, html);
      return html;
    };
    for (const row of RL115_CAPABILITY_INVENTORY) {
      if (row.verdict === "GAP") continue;
      const entries: NonNullable<CapabilityRow["entry"]>[] = [];
      if (row.entry !== undefined) entries.push(row.entry);
      if (row.contextualLink === undefined && row.explanatoryView === undefined && row.recovery === undefined && row.entry === undefined) {
        throw new Error(`${row.id}: VERIFIED rows must carry at least one surface expectation`);
      }
      for (const entry of entries) {
        const html = await doc(entry.page);
        for (const needle of entry.mustRender) {
          expect(html, `${row.id}: entry '${entry.page}' must render '${needle}'`).toContain(needle);
        }
      }
    }
  });

  it("every VERIFIED row's explanatory view renders its evidence", async () => {
    const { app } = buildApp();
    const paramsFor = (page: string): Record<string, string> | undefined =>
      page === "device" ? { deviceId: PHONE_ID } :
      page === "intent" ? { intentId: SEEDED_INTENT_ID } :
      page === "order" ? { orderId: SEED_ORDER_ID } :
      page === "case" ? { caseId: CASE_ID } :
      undefined;
    for (const row of RL115_CAPABILITY_INVENTORY) {
      if (row.explanatoryView === undefined || row.verdict === "GAP") continue;
      const params = paramsFor(row.explanatoryView.page);
      const html = await app.renderDocument({
        page: row.explanatoryView.page,
        ...(params !== undefined ? { params } : {}),
      });
      for (const needle of row.explanatoryView.mustRender) {
        expect(html, `${row.id}: explanatory view '${row.explanatoryView.page}' must render '${needle}'`).toContain(needle);
      }
    }
  });
});

describe("RL-115 §15.2 contextual links from the journey (render-level)", () => {
  it("every VERIFIED row's contextual link is rendered on the journey page that makes it relevant", async () => {
    const { app } = buildApp();
    const cache = new Map<string, string>();
    const doc = async (page: string, params?: Record<string, string>): Promise<string> => {
      const key = `${page}:${JSON.stringify(params ?? {})}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const html = await app.renderDocument({ page: page as never, ...(params !== undefined ? { params } : {}) });
      cache.set(key, html);
      return html;
    };
    const paramsFor = (page: string): Record<string, string> | undefined =>
      page === "device" ? { deviceId: PHONE_ID } :
      page === "intent" ? { intentId: SEEDED_INTENT_ID } :
      page === "order" ? { orderId: SEED_ORDER_ID } :
      page === "case" ? { caseId: CASE_ID } :
      undefined;
    for (const row of RL115_CAPABILITY_INVENTORY) {
      if (row.verdict === "GAP" || row.contextualLink === undefined) continue;
      const html = await doc(row.contextualLink.from, paramsFor(row.contextualLink.from));
      // The href must appear in an anchor whose content carries the label
      // (query params — e.g. the support escape's carried context — allowed).
      const anchorRe = new RegExp(
        `<a [^>]*href="${row.contextualLink.href.replaceAll("?", "\\?")}(\\?[^"]*)?"[^>]*>[\\s\\S]{0,600}?${row.contextualLink.labelContains}`,
      );
      expect(
        anchorRe.test(html),
        `${row.id}: ${row.contextualLink.from} must link '${row.contextualLink.href}' with label containing '${row.contextualLink.labelContains}'`,
      ).toBe(true);
    }
  });
});

describe("RL-115 §15.4 recovery/support paths (render-level)", () => {
  it("the support escape pre-carries the degraded surface's context transparently", async () => {
    const { app } = buildApp();
    // A support case opened FROM a degraded device page arrives with the
    // carried context rendered BEFORE the case is opened (the customer
    // decides with full information).
    const carried = await app.renderDocument({
      page: "support",
      params: {
        about: "My device needs its capability verification re-checked.",
        ref: `device~${PHONE_ID}`,
      },
    });
    expect(carried).toContain('data-carried-support-context="true"');
    expect(carried).toContain("Context carried from the page you came from");
    expect(carried).toContain(`device ${PHONE_ID}`);
    // The escape affordance renders its transparency note (what will be attached)
    // — on the Connectivity center, where a degraded evidence state is live in
    // the seeded world.
    const escape = await app.renderDocument({ page: "connectivity" });
    expect(escape).toMatch(/data-support-context="[^"]+"/);
    expect(escape).toContain("Opens Support with:");
  });

  it("every VERIFIED row's recovery marker renders on its recovery page", async () => {
    const { app } = buildApp();
    const paramsFor = (page: string): Record<string, string> | undefined =>
      page === "device" ? { deviceId: PHONE_ID } :
      page === "intent" ? { intentId: SEEDED_INTENT_ID } :
      page === "order" ? { orderId: SEED_ORDER_ID } :
      page === "case" ? { caseId: CASE_ID } :
      undefined;
    for (const row of RL115_CAPABILITY_INVENTORY) {
      if (row.recovery === undefined || row.verdict === "GAP") continue;
      const params = paramsFor(row.recovery.page);
      const html = await app.renderDocument({
        page: row.recovery.page,
        ...(params !== undefined ? { params } : {}),
      });
      for (const needle of row.recovery.mustRender) {
        expect(html, `${row.id}: recovery path '${row.recovery.page}' must render '${needle}'`).toContain(needle);
      }
    }
  });
});

// --------------------------------------------------------------------------------
// The GAP probes (pinned absences — the audit's negative proofs)
// --------------------------------------------------------------------------------

describe("RL-115 GAP probes (pinned, recorded — not fixed)", () => {
  it("GAP CAP-X-ESIM-MANAGE (RL-115-F1): zero eSIM vocabulary on the customer web surface", async () => {
    const { app } = buildApp();
    const documents: string[] = [];
    for (const page of Object.keys(WEB_PAGE_ROUTES)) {
      const params =
        page === "device" ? { deviceId: PHONE_ID } :
        page === "intent" ? { intentId: SEEDED_INTENT_ID } :
        page === "order" ? { orderId: SEED_ORDER_ID } :
        page === "case" ? { caseId: CASE_ID } :
        undefined;
      documents.push(await app.renderDocument({ page: page as never, ...(params !== undefined ? { params } : {}) }));
    }
    const joined = documents.join("\n").toLowerCase();
    expect(joined).not.toContain("esim");
    expect(joined).not.toContain("e-sim");
    expect(joined).not.toContain("sim selection");
  });

  it("GAP CAP-E-CONNECTOR-ENROLLMENT (RL-115-F3): connector status renders but no enrollment action does", async () => {
    // A workspace WITHOUT enterprise fixtures (the honest pre-enrollment world).
    const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
    const tenant = seed.tenants[TENANT];
    if (tenant === undefined) throw new Error("missing tenant in seed");
    const { enterprise: _stripped, ...rest } = tenant;
    const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants, [TENANT]: rest };
    const { app } = buildApp({ seed: { ...seed, tenants } });
    const workspace = await app.renderDocument({ page: "workspace" });
    // The status IS rendered (honest absent state)...
    expect(workspace).toContain('data-connector-absent="true"');
    expect(workspace).toContain("No connector has been set up yet.");
    // ...and the journey step says Not started...
    expect(workspace).toContain('data-workspace-step="connector"');
    expect(workspace).toMatch(/data-workspace-step="connector"[^>]*>[\s\S]{0,400}?Not started/);
    // ...but NO anchor offers connector enrollment/provisioning.
    const anchors = [...workspace.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    const enrollAnchors = anchors.filter((a) => /connector|provision|enroll/i.test(a.replace(/<[^>]+>/g, " ")));
    expect(enrollAnchors, "no connector-enrollment affordance exists").toEqual([]);
  });

  it("GAP CAP-SLO (RL-115-F2): no surface links to the /ops/slo dashboard and no nav names SLO health", async () => {
    const { app } = buildApp();
    for (const page of ["home", "settings", "more", "workspace", "connectivity"] as const) {
      const html = await app.renderDocument({ page });
      expect(html, `${page}: no /ops/slo link`).not.toContain("/ops/slo");
      expect(html, `${page}: no SLO nav vocabulary`).not.toMatch(/SLO/i);
    }
    // The frozen navigation vocabularies carry no SLO destination.
    for (const nav of [...DESKTOP_NAV, ...MOBILE_NAV]) {
      expect(nav.label).not.toMatch(/SLO/i);
      expect(nav.href).not.toContain("/ops");
    }
  });

  it("GAP CAP-B-REFUNDS (RL-115-F4): the commerce surface renders no refund state anywhere", async () => {
    const { app } = buildApp();
    const commerce = await app.renderDocument({ page: "commerce" });
    const order = await app.renderDocument({ page: "order", params: { orderId: SEED_ORDER_ID } });
    for (const html of [commerce, order]) {
      expect(html.toLowerCase()).not.toContain("refund");
    }
  });

  it("GAP CAP-E-SSO-SCIM-MDM (RL-115-F5): zero SSO/SCIM/MDM vocabulary on any rendered surface", async () => {
    const { app } = buildApp();
    for (const page of ["workspace", "settings", "more"] as const) {
      const html = await app.renderDocument({ page });
      expect(html).not.toMatch(/SSO|SCIM|MDM/i);
    }
  });

  it("GAP CAP-D-COMPAT (RL-115-F6): no integration/compatibility health surface exists in the customer nav or pages", async () => {
    const { app } = buildApp();
    for (const page of ["more", "settings", "home"] as const) {
      const html = await app.renderDocument({ page });
      expect(html.toLowerCase()).not.toContain("compatibility");
    }
    // (The admin-side absence is pinned structurally in tests/architecture.)
  });

  it("GAP CAP-B-ORDERS (RL-115-F8, pinned): the commerce Orders table renders no order links — the delivery-progress view is URL-only", async () => {
    const { app } = buildApp();
    const commerce = await app.renderDocument({ page: "commerce" });
    // The orders table exists...
    expect(commerce).toContain('data-orders="true"');
    // ...and the seeded order is rendered as a row (its id as text)...
    expect(commerce).toContain(SEED_ORDER_ID);
    // ...but NOTHING in the document links to the order journey route.
    expect(commerce).not.toContain("/orders/");
  });

  it("GAP CAP-E-POLICY (RL-115-F7): the policy summary renders its own honest not-available state", async () => {
    const { app } = buildApp();
    const workspace = await app.renderDocument({ page: "workspace" });
    expect(workspace).toContain('data-policy-gap="true"');
    expect(workspace).toContain("Not available yet");
    expect(workspace).toMatch(/data-workspace-step="policy"[^>]*>[\s\S]{0,400}?Not available yet/);
  });
});

// --------------------------------------------------------------------------------
// Inventory hygiene
// --------------------------------------------------------------------------------

describe("RL-115 inventory hygiene", () => {
  it("ids are unique and every row cites a frozen spec section", () => {
    const ids = RL115_CAPABILITY_INVENTORY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of RL115_CAPABILITY_INVENTORY) {
      expect(row.spec, `${row.id}: spec citation`).toMatch(/^spec\/architecture\.md/);
      expect(row.verdict).toMatch(/^(VERIFIED|VERIFIED\(proxy\)|GAP)$/);
    }
  });

  it("VERIFIED rows carry their four §15 surfaces; GAP rows carry a note", () => {
    for (const row of RL115_CAPABILITY_INVENTORY) {
      if (row.verdict === "GAP") {
        expect(row.gapNote?.length ?? 0, `${row.id}: GAP note`).toBeGreaterThan(20);
        continue;
      }
      expect(row.entry ?? row.explanatoryView ?? row.recovery, `${row.id}: at least one surface`).toBeDefined();
    }
  });

  it("the first-run journey discovers its own entry points from an empty world", async () => {
    const { app } = buildApp({ seed: freshCustomerSeed() });
    const home = await app.renderDocument({ page: "home" });
    // The fresh Home links the journey starter (onboarding) and the devices
    // surface; the getting-started panel names the four short steps.
    expect(home).toContain('href="/onboarding"');
    expect(home).toContain("Get started");
    expect(home).toContain("No devices enrolled yet.");
    // The empty devices page is the contextual entry for the first device.
    const devices = await app.renderDocument({ page: "devices" });
    expect(devices).toContain("Add your first device");
    // The more sheet carries the rest of the primary destinations.
    const more = await app.renderDocument({ page: "more" });
    for (const href of ["/intents", "/commerce", "/support", "/settings", "/workspace"]) {
      expect(more, `more sheet links ${href}`).toContain(`href="${href}"`);
    }
  });
});
