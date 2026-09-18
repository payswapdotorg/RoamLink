/**
 * Shell navigation + persistent connectivity status contract tests (RL-083).
 *
 * Locks the EXACT customer navigation (spec/ux-architecture.md §3):
 *   Desktop: Home | Connectivity | Activity | Devices | Goals |
 *            Plans & Billing | Support
 *   Mobile:  Home | Connect | Activity | Devices | More
 * and the More sheet contents (Goals, Plans & Billing, Support, Settings),
 * plus the a11y contract: skip link, aria-current, semantic landmarks,
 * warm-light stylesheet a11y rules, and a persistent connectivity indicator
 * that renders honestly for every state (never color alone).
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type HttpTransport,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp, DESKTOP_NAV, MOBILE_NAV } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";

function buildApp(options?: { transport?: HttpTransport }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(fakeApiSeed(), {
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

describe("the shell navigation contract (spec/ux-architecture.md §3)", () => {
  it("the desktop sidebar carries the exact seven destinations in order", () => {
    expect(DESKTOP_NAV.map((l) => l.label)).toEqual([
      "Home",
      "Connectivity",
      "Activity",
      "Devices",
      "Goals",
      "Plans & Billing",
      "Support",
    ]);
  });

  it("the mobile bottom nav carries the exact five destinations in order", () => {
    expect(MOBILE_NAV.map((l) => l.label)).toEqual([
      "Home",
      "Connect",
      "Activity",
      "Devices",
      "More",
    ]);
  });

  it("every rendered document carries both navs with the active destination marked", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "home" });
    expect(document).toContain('aria-label="Primary"');
    expect(document).toContain('aria-label="Primary mobile"');
    // Home is active on the home page; nothing else is.
    expect(document).toContain('href="/" aria-current="page"');
    expect(document).not.toContain('href="/connectivity" aria-current="page"');
    // Both nav families render all destinations.
    for (const label of ["Home", "Connectivity", "Activity", "Devices", "Goals", "Plans &amp; Billing", "Support", "Connect", "More"]) {
      expect(document).toContain(`>${label}</a>`);
    }
  });

  it("the Goals destination renders the ExperienceIntent surface under its human label", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "intents" });
    expect(document).toContain('href="/intents" aria-current="page"');
    expect(document).toContain("Goals");
    // The advanced label stays available (spec §7).
    expect(document).toContain("Advanced: experience intents");
  });

  it("the More sheet contains exactly Goals, Plans & Billing, Support and Settings", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "more" });
    expect(page.html).toContain('data-more-sheet="true"');
    for (const label of ["Goals", "Plans &amp; Billing", "Support", "Settings"]) {
      expect(page.html).toContain(`<strong>${label}</strong>`);
    }
    for (const href of ["/intents", "/commerce", "/support", "/settings"]) {
      expect(page.html).toContain(`href="${href}"`);
    }
    // And nothing else is in the More sheet.
    expect(page.html).not.toContain('href="/devices"');
  });

  it("Activity is a first-class destination and renders the automation narrative", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "activity" });
    expect(document).toContain('href="/activity" aria-current="page"');
    expect(document).toContain("Needs your attention");
    expect(document).toContain("What RoamLink did");
    // The seeded notification appears as an activity item.
    expect(document).toContain("Connectivity evidence linked");
    // The dedicated notifications route remains available (compat rule).
    const legacy = await app.renderPage({ page: "notifications" });
    expect(legacy.html).toContain("Notifications");
  });

  it("Settings renders the account + preferences surface from the actor session", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "settings" });
    // Settings is reached through More, not a sidebar destination, so the
    // shell correctly marks no sidebar link active for it.
    expect(document).toContain('data-settings-account="true"');
    expect(document).toContain(TENANT);
    expect(document).toContain("Connectivity preferences");
  });
});

describe("the persistent shell connectivity indicator", () => {
  it("renders the derived state in the shell with its facts, from the real read", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "home" });
    // The seed has one EVIDENCED-FRESH order reference and one UNEVIDENCED
    // subscription: fresh evidence wins, and the facts stay visible.
    expect(document).toContain('data-shell-connectivity="evidenced-fresh"');
    expect(document).toContain("Usefully connected");
    expect(document).toContain("delivery evidence UNEVIDENCED");
    expect(document).toContain('role="status"');
  });

  it("when the connectivity read fails the shell says it cannot confirm - never a guess", async () => {
    const { app } = buildApp({
      transport: {
        async request(): Promise<HttpResponse> {
          return {
            status: 503,
            body: JSON.stringify({
              kind: "unavailable",
              reason: "ADCOS_PROJECTION_STORE_DOWN",
              message: "projection reads are temporarily unavailable",
              retryable: true,
              details: [],
            }),
          };
        },
      },
    });
    const document = await app.renderDocument({ page: "home" });
    expect(document).toContain('data-shell-connectivity="unverifiable"');
    expect(document).toContain("Cannot confirm right now");
    // The page BODY still fails closed independently.
    expect(document).toContain('data-error-kind="unavailable"');
  });

  it("the stale-only world renders stale (freshness guarantee expired)", async () => {
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const document = await app.renderDocument({ page: "connectivity" });
    expect(document).toContain('data-shell-connectivity="evidenced-stale"');
    expect(document).toContain("Delivery evidenced — stale");
    expect(document).not.toContain("Usefully connected");
  });
});

describe("shell accessibility contract", () => {
  it("every document has the skip link, main landmark, footer and reduced-motion + focus rules", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "home" });
    expect(document).toContain('class="shell-skip-link" href="#shell-main"');
    expect(document).toContain('id="shell-main"');
    expect(document).toContain("<footer");
    expect(document).toContain("prefers-reduced-motion");
    expect(document).toContain(":focus-visible");
    // Touch targets + mobile safe-area handling in the bottom nav CSS.
    expect(document).toContain("min-height: 48px");
    expect(document).toContain("env(safe-area-inset-bottom");
    // Warm-light surface (never color-alone state: text always accompanies).
    expect(document).toContain("#faf8f5");
  });

  it("the Home hero answers the four questions in one viewport with distinct facts", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "home" });
    expect(page.html).toContain('data-home-hero="true"');
    expect(page.html).toContain('data-home-facts="true"');
    expect(page.html).toContain("Your current goal");
    expect(page.html).toContain("What RoamLink is doing");
    expect(page.html).toContain("Does RoamLink need you?");
    expect(page.html).toContain("Your devices");
    // State families stay separate on the hero (no opaque combined badge).
    expect(page.html).not.toMatch(/data-overall-status|data-combined-status/);
    expect(page.html).toContain("data-freshness=");
  });

  it("the home hero claims 'usefully connected' only with fresh delivery evidence", async () => {
    const { app, clock } = buildApp();
    const fresh = await app.renderPage({ page: "home" });
    expect(fresh.html).toContain("You are usefully connected");

    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const stale = await app.renderPage({ page: "home" });
    expect(stale.html).not.toContain("You are usefully connected");
    expect(stale.html).toContain("not fresh");
  });
});
