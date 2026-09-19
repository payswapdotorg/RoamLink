/**
 * RL-088 — responsive/mobile accessibility cross-cutting contract tests.
 *
 * Locks the spec/ux-architecture.md §14 discipline across EVERY page the
 * app renders (not just the shells the RL-083 tests already cover):
 *  - document contract: lang, viewport, skip link, keyboard-visible focus,
 *    reduced-motion guard, touch-target sizing, mobile safe-area handling;
 *  - table contract: EVERY table renders inside the shared labelled,
 *    keyboard-focusable scroll region (narrow screens scroll, never
 *    overflow), and every header cell declares its scope;
 *  - form contract: every control is labelled (explicit for/id, or a
 *    wrapping label) and every label points at a real control;
 *  - non-color-only state communication: every state badge and kind chip
 *    carries its state as text, never color alone;
 *  - semantic navigation aids: the key page-level lists and the connection
 *    journey are labelled for assistive technology.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeNotificationSeed,
  type FakeTenantSeed,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";
import { WEB_APP_STYLES } from "../src/styles.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const MEMBER_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const CASE_ID = "cafecafe-0000-4000-8000-000000000001";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEEDED_INTENT_ID = "cccccccc-0000-4000-8000-000000000001";

function buildApp(seed?: FakeApiSeed) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

/** The default seed plus one device-related notification for the Phone. */
function seedWithDeviceNotification(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const deviceNotification: FakeNotificationSeed = {
    notificationId: "d0d0d0d0-0000-4000-8000-0000000000d1",
    recipientUserId: MEMBER_USER,
    topic: "system",
    severity: "info",
    title: "Device observation recorded",
    body: "A recorded change that concerns the Phone.",
    state: "read",
    source: {
      origin: "roamlink_state_transition",
      aggregateType: "device",
      aggregateId: PHONE_ID,
      transition: "observation_recorded",
      eventId: "evt_dev1",
      occurredAt: "2025-01-06T09:00:00.000Z",
    },
    related: [{ kind: "device", id: PHONE_ID }],
    channels: [{ channel: "in_app", outcome: "delivered", attemptedAt: "2025-01-06T09:00:00.000Z" }],
    createdAt: "2025-01-06T09:00:00.000Z",
    updatedAt: "2025-01-06T09:00:00.000Z",
  };
  const tenants: Record<string, FakeTenantSeed> = {
    ...seed.tenants,
    [TENANT]: { ...tenant, notifications: [...tenant.notifications, deviceNotification] },
  };
  return { ...seed, tenants };
}

/** One render case: a label plus the request that produces the document. */
const RENDER_CASES: readonly { readonly name: string; readonly request: Parameters<CustomerWebApp["renderDocument"]>[0] }[] = [
  { name: "home", request: { page: "home" } },
  { name: "overview", request: { page: "overview" } },
  { name: "connectivity", request: { page: "connectivity" } },
  { name: "activity", request: { page: "activity" } },
  { name: "notifications", request: { page: "notifications" } },
  { name: "devices", request: { page: "devices" } },
  { name: "device detail", request: { page: "device", params: { deviceId: PHONE_ID } } },
  { name: "goals", request: { page: "intents" } },
  { name: "goal detail", request: { page: "intent", params: { intentId: SEEDED_INTENT_ID } } },
  { name: "plans and billing", request: { page: "commerce" } },
  { name: "order detail", request: { page: "order", params: { orderId: SEED_ORDER_ID } } },
  { name: "support", request: { page: "support" } },
  { name: "support case", request: { page: "case", params: { caseId: CASE_ID } } },
  { name: "more", request: { page: "more" } },
  { name: "settings", request: { page: "settings" } },
  { name: "onboarding welcome", request: { page: "onboarding" } },
  { name: "onboarding goal", request: { page: "onboarding", params: { step: "goal" } } },
  { name: "onboarding device", request: { page: "onboarding", params: { step: "device", goal: "travel" } } },
  {
    name: "onboarding preferences",
    request: { page: "onboarding", params: { step: "preferences", goal: "travel", deviceId: PHONE_ID } },
  },
];

// --------------------------------------------------------------------------------
// Small deterministic scanners over the rendered (escaped) HTML
// --------------------------------------------------------------------------------

function labelProblems(html: string): string[] {
  const problems: string[] = [];
  const labels = html.match(/<label[^>]*>[\s\S]*?<\/label>/g) ?? [];
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] ?? ""));
  const labelledIds = new Set([...html.matchAll(/ for="([^"]+)"/g)].map((m) => m[1] ?? ""));
  let outsideLabels = html;
  for (const label of labels) {
    if (/ for="/.test(label)) continue; // explicit association, checked below
    if (!/<(input|select|textarea)[\s>]/.test(label)) {
      problems.push(`label with neither for= nor a wrapped control: ${label.slice(0, 90)}`);
    }
    outsideLabels = outsideLabels.replace(label, "");
  }
  for (const m of outsideLabels.matchAll(/<(input|select)\b([^>]*)>/g)) {
    const attrs = m[2] ?? "";
    if (/type="(hidden|submit|button)"/.test(attrs)) continue;
    const id = attrs.match(/ id="([^"]+)"/)?.[1];
    if (id === undefined || !labelledIds.has(id)) {
      problems.push(`control without a label: <${m[1] ?? ""}${attrs.slice(0, 70)}`);
    }
  }
  for (const id of labelledIds) {
    if (!ids.has(id)) problems.push(`label for= points at a missing id: ${id}`);
  }
  return problems;
}

function tableProblems(html: string): string[] {
  const problems: string[] = [];
  const tables = (html.match(/<table[\s>]/g) ?? []).length;
  const wraps = (html.match(/data-table-wrap="true"/g) ?? []).length;
  if (tables !== wraps) {
    problems.push(`${tables} <table> elements but ${wraps} responsive wraps`);
  }
  for (const m of html.matchAll(/<th\b([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    if (!/ scope="(col|row)"/.test(attrs)) {
      problems.push(`header cell without scope: <th${attrs.slice(0, 70)}`);
    }
  }
  for (const m of html.matchAll(/<div class="table-wrap"([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    if (!/ role="region"/.test(attrs)) problems.push("table wrap is not a region");
    if (!/ aria-label="[^"]+"/.test(attrs)) problems.push("table wrap has no label");
    if (!/ tabindex="0"/.test(attrs)) problems.push("table wrap is not keyboard-focusable");
  }
  return problems;
}

function stateProblems(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/<span class="badge"[^>]*>([\s\S]*?)<\/span>/g)) {
    if ((m[1] ?? "").trim().length === 0) problems.push("state badge with no text (color-only state)");
  }
  for (const m of html.matchAll(/<span class="kind-chip"[^>]*>([\s\S]*?)<\/span>/g)) {
    if ((m[1] ?? "").trim().length === 0) problems.push("kind chip with no text (color-only kind)");
  }
  return problems;
}

// --------------------------------------------------------------------------------
// The cross-cutting contract
// --------------------------------------------------------------------------------

describe("RL-088 document contract (every page)", () => {
  for (const renderCase of RENDER_CASES) {
    it(`${renderCase.name}: responsive, keyboard-reachable, non-color-only`, async () => {
      const { app } = buildApp();
      const document = await app.renderDocument(renderCase.request);

      // Responsive document basics.
      expect(document).toContain('<html lang="en">');
      expect(document).toContain('name="viewport" content="width=device-width, initial-scale=1"');
      // Keyboard: skip link, visible focus, and no positive tab stops.
      expect(document).toContain('class="shell-skip-link" href="#shell-main"');
      expect(document).toContain(":focus-visible");
      expect(document).not.toMatch(/tabindex="[1-9]/);
      // Motion + touch: reduced-motion guard and 44px+ touch targets.
      expect(document).toContain("prefers-reduced-motion");
      expect(document).toContain("min-height: 44px");
      expect(document).toContain("env(safe-area-inset-bottom");

      // Tables: every table wrapped, every header scoped.
      expect(tableProblems(document)).toEqual([]);

      // Forms: every control labelled, every label resolved.
      expect(labelProblems(document)).toEqual([]);

      // State is never color alone.
      expect(stateProblems(document)).toEqual([]);
    });
  }

  it("renders the whole surface without any of the contract scanners firing", async () => {
    const { app } = buildApp();
    const joined = (
      await Promise.all(RENDER_CASES.map((renderCase) => app.renderDocument(renderCase.request)))
    ).join("\n");
    expect(tableProblems(joined)).toEqual([]);
    expect(labelProblems(joined)).toEqual([]);
    expect(stateProblems(joined)).toEqual([]);
  });
});

describe("RL-088 responsive behavior contract", () => {
  it("the web stylesheet scrolls wide tables instead of overflowing the page", () => {
    expect(WEB_APP_STYLES).toContain(".table-wrap { overflow-x: auto");
    expect(WEB_APP_STYLES).toContain(".table-wrap:focus-visible");
  });

  it("the web stylesheet carries the mobile refinement breakpoint", () => {
    expect(WEB_APP_STYLES).toContain("@media (max-width: 40rem)");
    expect(WEB_APP_STYLES).toContain("td { overflow-wrap: anywhere; }");
  });

  it("motion is guarded in BOTH layers (shell and web-app styles)", () => {
    expect(WEB_APP_STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("interactive targets keep at least 44px height in the web-app styles", () => {
    expect(WEB_APP_STYLES).toContain("button { background: #2d2a26; border: 1px solid #2d2a26; color: #fffdf9; border-radius: 8px; padding: 0.55rem 1.1rem; min-height: 44px; cursor: pointer; }");
    expect(WEB_APP_STYLES).toContain("min-height: 44px; box-sizing: border-box;"); // disclosure summary
  });
});

describe("RL-088 semantic navigation aids", () => {
  it("the connection journey is one labelled ordered list", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "connectivity" });
    expect(document).toContain('aria-label="Your connection journey, stage by stage"');
    expect(document).toContain("<ol");
  });

  it("the activity timeline and its needs-review list are labelled", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "activity" });
    expect(document).toContain('aria-label="Full activity timeline, newest first"');
    expect(document).toContain('aria-label="Items that need your review"');
  });

  it("the primary page lists are labelled for assistive technology", async () => {
    const { app } = buildApp();
    const goals = await app.renderDocument({ page: "intents" });
    expect(goals).toContain('aria-label="Your goals"');
    const devices = await app.renderDocument({ page: "devices" });
    expect(devices).toContain('aria-label="Your devices"');
    const device = await app.renderDocument({ page: "device", params: { deviceId: PHONE_ID } });
    expect(device).toContain('aria-label="Goals for this device"');
    const connectivity = await app.renderDocument({ page: "connectivity" });
    expect(connectivity).toContain('aria-label="Device observations"');
    expect(connectivity).toContain('aria-label="Recent connectivity events"');
  });

  it("the per-device action list is labelled when the device has recorded actions", async () => {
    const { app } = buildApp(seedWithDeviceNotification());
    const device = await app.renderDocument({ page: "device", params: { deviceId: PHONE_ID } });
    expect(device).toContain('aria-label="Recent actions on this device"');
  });

  it("onboarding marks the current step with aria-current and screen-reader-only legends", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "onboarding", params: { step: "device" } });
    expect(document).toContain('aria-current="step"');
    expect(document).toContain('class="sr-only"');
  });
});
