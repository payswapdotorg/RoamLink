/**
 * RL-114 — extended responsive/accessibility verification (web surface).
 *
 * Extends the RL-088 foundation (test/responsive-a11y.test.ts, unchanged)
 * with the spec/ux-architecture.md §14 dimensions it does not yet cover:
 *
 *  1. SEMANTIC HEADING HIERARCHY — every rendered surface's headings form a
 *     valid hierarchy (h1 presence per document, no skipped levels);
 *  2. LOADING/ERROR/EMPTY STATES for EVERY primary surface — the RL-082
 *     forbidden-vocabulary discipline generalized: no unexplained technical
 *     error dumps anywhere, every empty world explicitly explained;
 *  3. TOUCH-TARGET coverage on ALL interactive elements — links and summary
 *     elements, not only buttons;
 *  4. FRESH/STALE/UNKNOWN text+visual pairing completeness — state is never
 *     color-only NOR icon-only, generalized over every badge family.
 *
 * VERIFICATION-ONLY DISCIPLINE (the threat-model-verification.md precedent):
 * this suite records findings as PINNED assertions over the current
 * observable behavior, so the eventual fixes flip explicit assertions.
 * No src file is touched by this work item. The findings recorded here:
 *
 *  RL-114-F1 — the customer web shell renders the app title as a plain
 *    anchor, so NO rendered web document contains an <h1>: every document's
 *    heading hierarchy starts at h2. (Pinned below in "heading hierarchy".)
 *  RL-114-F2 — heading-level skips on the edge paths: the Connectivity
 *    center's evidence/technical disclosure panels render <h4> under an
 *    <h2> context (h2->h4 skip); read-failure bodies and mutation-result
 *    panels lead with an <h3> before any <h1>/<h2> exists.
 *  RL-114-F3 — the 44px touch-target floor covers buttons, inputs, the
 *    disclosure summary, the nav families and the card-style action links,
 *    but NOT the generic in-content action links (home fact-card links,
 *    goal/device card links, journey "Open ..." links) nor the shell
 *    indicator's "Connectivity details" link.
 *  RL-114-F4 — the /notifications page is reachable by URL only: no nav
 *    destination, More-sheet entry or in-page link points at it (the
 *    dedicated route is a compatibility surface per spec §8; recorded here
 *    because it is also a discoverability fact).
 *
 * The per-journey mobile-variant document contract lives in
 * apps/mobile/test/rl114-mobile-document-contract.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  ApiClientError,
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
  type HttpTransport,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";
import { WEB_APP_STYLES } from "../src/styles.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const CASE_ID = "cafecafe-0000-4000-8000-000000000001";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEEDED_INTENT_ID = "cccccccc-0000-4000-8000-000000000001";

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

function buildApp(options?: {
  readonly seed?: FakeApiSeed;
  readonly transport?: HttpTransport;
}) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: options?.transport ?? fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

/** Transport that fails every request with the typed unavailable error. */
function unavailableTransport(): HttpTransport {
  return {
    async request() {
      throw new ApiClientError({
        kind: "unavailable",
        reason: "TRANSPORT_UNAVAILABLE",
        message: "the RoamLink API is unreachable",
        retryable: true,
        status: 0,
      });
    },
  };
}

/** Every primary surface of the customer web app (RL-083 + RL-104 routes). */
const RENDER_CASES: readonly {
  readonly name: string;
  readonly request: Parameters<CustomerWebApp["renderDocument"]>[0];
  /** true when the page performs reads (can fail closed). */
  readonly reads: boolean;
}[] = [
  { name: "home", request: { page: "home" }, reads: true },
  { name: "overview", request: { page: "overview" }, reads: true },
  { name: "connectivity", request: { page: "connectivity" }, reads: true },
  { name: "activity", request: { page: "activity" }, reads: true },
  { name: "notifications", request: { page: "notifications" }, reads: true },
  { name: "devices", request: { page: "devices" }, reads: true },
  { name: "device detail", request: { page: "device", params: { deviceId: PHONE_ID } }, reads: true },
  { name: "goals", request: { page: "intents" }, reads: true },
  { name: "goal detail", request: { page: "intent", params: { intentId: SEEDED_INTENT_ID } }, reads: true },
  { name: "plans and billing", request: { page: "commerce" }, reads: true },
  { name: "order detail", request: { page: "order", params: { orderId: SEED_ORDER_ID } }, reads: true },
  { name: "support", request: { page: "support" }, reads: true },
  { name: "support case", request: { page: "case", params: { caseId: CASE_ID } }, reads: true },
  { name: "workspace", request: { page: "workspace" }, reads: true },
  { name: "settings", request: { page: "settings" }, reads: true },
  { name: "more", request: { page: "more" }, reads: false },
  { name: "onboarding welcome", request: { page: "onboarding" }, reads: false },
  { name: "onboarding goal", request: { page: "onboarding", params: { step: "goal" } }, reads: false },
  {
    name: "onboarding device",
    request: { page: "onboarding", params: { step: "device", goal: "travel" } },
    reads: true,
  },
  {
    name: "onboarding preferences",
    request: { page: "onboarding", params: { step: "preferences", goal: "travel", deviceId: PHONE_ID } },
    reads: true,
  },
];

// --------------------------------------------------------------------------------
// Scanners (same deterministic pattern as the RL-088 suite)
// --------------------------------------------------------------------------------

export interface HeadingInventory {
  /** Heading levels in document order. */
  readonly levels: readonly number[];
  /** The level of the first heading (0 when the document has none). */
  readonly firstLevel: number;
  readonly h1Count: number;
  /** hN -> hM transitions where M > N + 1 (skipped levels). */
  readonly skips: readonly string[];
}

export function headingInventory(html: string): HeadingInventory {
  const levels = [...html.matchAll(/<h([1-6])(?:\s[^>]*)?>/g)].map((m) => Number(m[1]));
  const skips: string[] = [];
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1] ?? 0;
    const next = levels[i] ?? 0;
    if (next > prev + 1) skips.push(`h${prev}->h${next}`);
  }
  return {
    levels,
    firstLevel: levels[0] ?? 0,
    h1Count: levels.filter((l) => l === 1).length,
    skips,
  };
}

/** Every `<span class="badge" data-*="...">` must carry its state as text. */
export function badgeTextProblems(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/<span class="badge"([^>]*)>([\s\S]*?)<\/span>/g)) {
    const attrs = m[1] ?? "";
    const text = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (text.length === 0) {
      problems.push(`badge with no text (color-only state): ${attrs.slice(0, 80)}`);
      continue;
    }
    const freshness = attrs.match(/data-freshness="([^"]+)"/)?.[1];
    if (freshness !== undefined && !text.includes(freshness)) {
      problems.push(`freshness badge text '${text.slice(0, 40)}' does not carry state '${freshness}'`);
    }
    const evidence = attrs.match(/data-evidence="([^"]+)"/)?.[1];
    if (evidence !== undefined && !text.includes(evidence)) {
      problems.push(`evidence badge text '${text.slice(0, 40)}' does not carry state '${evidence}'`);
    }
  }
  // The journey stage words and the shell indicator headline are the other
  // state carriers: they must exist as text next to their data attribute.
  for (const m of html.matchAll(/<span class="journey-state"([^>]*)>([\s\S]*?)<\/span>/g)) {
    if ((m[2] ?? "").trim().length === 0) {
      problems.push(`journey state span with no text: ${(m[1] ?? "").slice(0, 60)}`);
    }
  }
  for (const m of html.matchAll(/<span class="shell-indicator-label"[^>]*>([\s\S]*?)<\/span>/g)) {
    if ((m[1] ?? "").trim().length === 0) {
      problems.push("shell indicator headline with no text (color-only connectivity state)");
    }
  }
  return problems;
}

/** Extracts the `min-height: 44px`-bearing selectors from a stylesheet. */
export function selectorsWith44px(css: string): string[] {
  const found: string[] = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? "").replace(/[}\n]/g, " ").trim();
    const body = m[2] ?? "";
    if (/min-height:\s*4[48]px/.test(body) && selector.length > 0) {
      found.push(selector);
    }
  }
  return found.sort();
}

// --------------------------------------------------------------------------------
// 1. Semantic heading hierarchy
// --------------------------------------------------------------------------------

describe("RL-114 semantic heading hierarchy (spec/ux-architecture.md §14)", () => {
  it("FINDING RL-114-F1 (pinned): no rendered web document contains an h1 — every hierarchy starts at h2", async () => {
    // The application shell renders the app title as `<a class="shell-title">`
    // (packages/app-kit/src/ui/shell.ts applicationShell), so the page-level
    // h2 from pageHeading() is the FIRST heading of every document. The §14
    // rule "semantic headings" wants an h1 per document. Pinned as-is; the
    // shell fix (title becomes the h1) flips every assertion in this test.
    const { app } = buildApp();
    for (const renderCase of RENDER_CASES) {
      const document = await app.renderDocument(renderCase.request);
      const inventory = headingInventory(document);
      expect(inventory.h1Count, `${renderCase.name}: h1 count`).toBe(0);
      expect(inventory.firstLevel, `${renderCase.name}: first heading level`).toBe(2);
    }
  });

  it("no OTHER level skips exist beyond the pinned RL-114-F2 connectivity disclosure skip", async () => {
    const { app } = buildApp();
    const skipsByCase = new Map<string, readonly string[]>();
    for (const renderCase of RENDER_CASES) {
      const inventory = headingInventory(await app.renderDocument(renderCase.request));
      if (inventory.skips.length > 0) skipsByCase.set(renderCase.name, inventory.skips);
    }
    // FINDING RL-114-F2 (pinned): the Connectivity center's evidence and
    // technical disclosure panels render h4 subject headings directly under
    // the h2 section context — the FIRST h4 after the h2 section heading is
    // a skipped level (h2->h4). Every other surface is skip-free.
    expect([...skipsByCase.entries()]).toEqual([["connectivity", ["h2->h4"]]]);
  });

  it("FINDING RL-114-F2 (pinned): read-failure bodies lead with an h3 before any h1/h2 exists", async () => {
    const { app } = buildApp({ transport: unavailableTransport() });
    for (const renderCase of RENDER_CASES.filter((c) => c.reads)) {
      const document = await app.renderDocument(renderCase.request);
      const inventory = headingInventory(document);
      // The typed error panel's "The request failed" is an h3 and it is the
      // only heading on a failed read (no h1 from the shell — RL-114-F1).
      expect(inventory.firstLevel, `${renderCase.name}: first heading on failed read`).toBe(3);
      expect(document).toContain(">The request failed</h3>");
    }
  });

  it("FINDING RL-114-F2 (pinned): a surfaced mutation result leads with the pipeline h3", async () => {
    const { app } = buildApp();
    const withResult = await app.renderDocument({
      page: "intents",
      lastResult: {
        status: "error",
        error: new Error("unexpected"),
      },
    });
    // The mutation-result panel renders BEFORE the page body, so its h3
    // ("The request failed" / "Command acknowledged") precedes the page h2.
    expect(headingInventory(withResult).firstLevel).toBe(3);
    // The panel itself explains honestly (no raw dump): unknown errors are
    // reduced to a generic sentence, never third-party error text.
    expect(withResult).toContain("An unexpected error occurred (details suppressed");
  });
});

// --------------------------------------------------------------------------------
// 2. Loading / error / empty states for every primary surface
// --------------------------------------------------------------------------------

describe("RL-114 loading/error/empty states for every primary surface (§14)", () => {
  it("every read-backed surface fails closed with a loading panel plus a typed, explained error panel", async () => {
    const { app } = buildApp({ transport: unavailableTransport() });
    for (const renderCase of RENDER_CASES.filter((c) => c.reads)) {
      const document = await app.renderDocument(renderCase.request);
      expect(document, `${renderCase.name}: loading panel`).toContain('data-loading="true"');
      expect(document, `${renderCase.name}: typed error panel`).toContain(
        'data-mutation-result="error"',
      );
      // The honest unavailability language, never a guessed status.
      expect(document, `${renderCase.name}: honest unavailability`).toContain(
        "RoamLink could not read",
      );
      // No unexplained technical dump: contract-borne messages only.
      expect(document, `${renderCase.name}: no raw error text`).not.toContain(
        "the RoamLink API is unreachable",
      );
    }
  });

  it("every surface explains an empty world explicitly (no bare empty tables/lists)", async () => {
    const { app } = buildApp({ seed: freshCustomerSeed() });
    const expectedEmptyMarker: Readonly<Record<string, readonly string[]>> = {
      home: ['data-getting-started="true"', "No connectivity reference is set up yet."],
      overview: ['data-empty="true"'],
      connectivity: ['data-subjects-empty="true"', 'data-observations-empty="true"', 'data-recent-events-empty="true"'],
      activity: ['data-activity-empty="true"'],
      notifications: ['data-notifications-empty="true"'],
      devices: ['data-devices-empty="true"', "No devices yet."],
      goals: ['data-goals-empty="true"'],
      "plans and billing": ['data-empty="true"'],
      support: ['data-empty="true"', "No support cases to show."],
      workspace: ['data-org-connectivity-empty="true"', 'data-fleet-empty="true"', 'data-workspace-goals-empty="true"'],
    };
    for (const [name, markers] of Object.entries(expectedEmptyMarker)) {
      const renderCase = RENDER_CASES.find((c) => c.name === name);
      if (renderCase === undefined) throw new Error(`missing render case ${name}`);
      const document = await app.renderDocument(renderCase.request);
      for (const marker of markers) {
        expect(document, `${name}: empty-state marker`).toContain(marker);
      }
    }
  });

  it("detail pages of a missing resource render the typed not-found panel (fail-closed, never a partial page)", async () => {
    const { app } = buildApp({ seed: freshCustomerSeed() });
    for (const renderCase of RENDER_CASES.filter((c) =>
      ["device detail", "goal detail", "order detail", "support case"].includes(c.name),
    )) {
      const document = await app.renderDocument(renderCase.request);
      expect(document, `${renderCase.name}: typed error`).toContain('data-mutation-result="error"');
      expect(document, `${renderCase.name}: honest failure sentence`).toContain("The request failed");
    }
  });

  it("FINDING RL-114-F4 (pinned): the /notifications page has no inbound link from any navigation or journey surface", async () => {
    // spec/ux-architecture.md §8: notifications are represented in Activity;
    // the dedicated route is kept for compatibility. Pinned fact: NOTHING
    // renders a link to /notifications, so the page is URL-only. A future
    // link (or a deliberate deprecation note) flips this assertion.
    const { app } = buildApp();
    for (const renderCase of RENDER_CASES) {
      const document = await app.renderDocument(renderCase.request);
      expect(document, `${renderCase.name}: inbound /notifications link`).not.toContain(
        'href="/notifications"',
      );
    }
  });
});

// --------------------------------------------------------------------------------
// 3. Touch targets on ALL interactive elements
// --------------------------------------------------------------------------------

/** Classes carried by `<a>` elements (their floor rule names the class). */
const ANCHOR_ELEMENT_CLASSES: ReadonlySet<string> = new Set([
  ".more-item-link",
  ".shell-indicator-link",
  ".shell-skip-link",
  ".shell-title",
]);

describe("RL-114 touch-target coverage on all interactive elements (§14)", () => {
  it("the VERIFIED 44px floor set: buttons, form controls, summary, both nav families, card links and escapes", () => {
    // Shell layer (WARM_SHELL_STYLES) + app layer (WEB_APP_STYLES) together
    // must keep these known-good floors (the RL-088 base plus the card-style
    // link families that already carry the floor).
    const web = selectorsWith44px(WEB_APP_STYLES);
    expect(web).toEqual(
      expect.arrayContaining([
        "button",
        'form input[type="text"], form select',
        ".disclosure summary",
        ".more-item-link",
        ".support-escape a",
        ".preference-option",
      ]),
    );
  });

  it("FINDING RL-114-F3 (pinned): generic in-content action links have no 44px touch-target floor", async () => {
    // The known-good `a` floors are exactly the shell nav families plus the
    // card/escape link families. Everything else — the home fact-card action
    // links ("Review your goal", "Open Activity", ...), the goal/device card
    // links ("Open this device"), the journey "Manage goals" links and the
    // shell indicator's "Connectivity details" link — is inline text with no
    // minimum size. Pinned as-is; a floor rule (or per-family rules) flips it.
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "home" });

    // The shell indicator link exists on every page and has no 44px rule.
    expect(document).toContain('class="shell-indicator-link"');

    // No generic `a { ... min-height }` rule exists in either stylesheet.
    expect(WEB_APP_STYLES).not.toMatch(/(^|\n)\s*a\s*\{[^}]*min-height/);

    // The exact current set of floored anchor selectors is frozen here: the
    // app layer floors exactly the card-style link families below — nothing
    // else (the shell layer additionally floors its two nav families). A new
    // floor (the fix for this finding) changes this set and flips the assert.
    const anchorFloors = selectorsWith44px(WEB_APP_STYLES).filter((s) =>
      s.includes(" a") || ANCHOR_ELEMENT_CLASSES.has(s),
    );
    expect(anchorFloors).toEqual([".more-item-link", ".support-escape a"]);
    expect(WEB_APP_STYLES).toContain(".home-fact-action a { font-weight: 600; }");
    expect(WEB_APP_STYLES).not.toContain(".home-fact-action a { font-weight: 600; min-height");
    expect(WEB_APP_STYLES).not.toContain(".goal-card a {");
  });
});

// --------------------------------------------------------------------------------
// 4. Fresh/stale/unknown text + visual pairing (generalized non-color-only)
// --------------------------------------------------------------------------------

describe("RL-114 fresh/stale/unknown text+visual pairing (§14, generalized)", () => {
  it("every badge carries its state as visible text across both worlds and the failure path", async () => {
    const seeded = buildApp();
    const fresh = buildApp({ seed: freshCustomerSeed() });
    const failing = buildApp({ transport: unavailableTransport() });
    const documents: string[] = [];
    for (const renderCase of RENDER_CASES) {
      documents.push(await seeded.app.renderDocument(renderCase.request));
      documents.push(await fresh.app.renderDocument(renderCase.request));
      documents.push(await failing.app.renderDocument(renderCase.request));
    }
    const joined = documents.join("\n");
    // Zero color-only or icon-only state carriers anywhere.
    expect(badgeTextProblems(joined)).toEqual([]);
    // The freshness families actually exercised include all three states.
    expect(joined).toMatch(/data-freshness="FRESH"/);
    expect(joined).toMatch(/data-freshness="STALE"/);
    expect(joined).toMatch(/data-freshness="UNKNOWN"/);
    // The shell indicator pairs its derived state with a visible label and
    // a data attribute on every document (text + visual, never color alone).
    for (const document of documents) {
      expect(document).toMatch(/data-shell-connectivity="[a-z-]+"[^>]*>[\s\S]*?<span class="shell-indicator-label">[^<]+<\/span>/);
    }
  });

  it("the honest unknown/stale language renders as text next to every unknown freshness badge", async () => {
    const { app } = buildApp({ seed: freshCustomerSeed() });
    const document = await app.renderDocument({ page: "home" });
    // The empty world's freshness is UNKNOWN, stated as text, never a color.
    expect(document).toContain('>UNKNOWN</span>');
    expect(document).toContain("No devices enrolled yet.");
    // The device detail card names the verification-absence discipline.
    const seeded = buildApp();
    const device = await seeded.app.renderDocument({ page: "device", params: { deviceId: PHONE_ID } });
    expect(device).toContain("Absence of verification is stated, never bridged with an assumption.");
    const stale = await seeded.app.renderDocument({ page: "connectivity" });
    // Stale is presented with its guarantee expiry, never hidden (RL-LOCK-010).
    expect(stale).toMatch(/data-freshness="STALE"[^>]*>[^<]*STALE/);
    expect(stale).toContain("freshness guarantee expired");
  });
});
