/**
 * RL-114 — the per-journey mobile-variant document contract (edge surface).
 *
 * Extends the RL-088 document contract (apps/web/test/responsive-a11y.test.ts)
 * to the MOBILE surface: every apps/mobile mobileDocument leg — Now,
 * Capabilities, Controls, Outbox (+ Enrollment and the action history) — is
 * rendered as a full document through the REAL views and shell, and the same
 * §14 scanner discipline is applied over it:
 *
 *  - document contract: lang, viewport, exactly one h1, valid heading
 *    hierarchy (h1 -> h2 -> h3), no positive tab stops;
 *  - fresh/stale/unknown text+visual pairing: every freshness/state badge
 *    carries its state as text, never color alone (the views' honesty laws);
 *  - degraded controls: observation + manual guidance rendered with the
 *    closed reason vocabulary, never a fake success;
 *  - the offline banner: last-known state, never fabricated.
 *
 * VERIFICATION-ONLY DISCIPLINE (threat-model-verification.md precedent) —
 * the mobile surface's contract gaps are recorded as PINNED findings so the
 * eventual fixes flip explicit assertions. No src file is touched:
 *
 *  RL-114-F5 — the mobile document shell (app-kit pageShell + the base
 *    document styles) lacks the a11y layer the customer web shell has: no
 *    skip link, no :focus-visible outline rule, no prefers-reduced-motion
 *    guard, no 44px touch-target floor, no safe-area-inset handling, and
 *    the nav has no accessible label.
 *  RL-114-F6 — the four mobile nav anchors (#now / #capabilities / #controls
 *    / #outbox) point at ids that do not exist in any rendered document:
 *    the screens render h2 headings without ids, so every nav link is dead.
 *  RL-114-F7 — the mobile tables (Now context, the capability matrix, the
 *    outbox, the action history) render <th> header cells without scope and
 *    outside any labelled, keyboard-focusable scroll region (no
 *    .table-wrap): on narrow screens the tables overflow, and header cells
 *    do not declare their scope.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { parseUtcInstant } from "@roamlink/contracts";
import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";
import { createAesGcmEdgePayloadCipher, parseDeviceActionId } from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";

import { MobileEdgeShell, type MobileConnectivityView } from "../src/shell.js";
import { InMemoryMobilePlatformProbe } from "../src/platform-probe.js";
import {
  actionHistoryScreen,
  actionOutcomeScreen,
  capabilityMatrixScreen,
  connectivityScreen,
  enrollmentScreen,
  mobileDocument,
  outboxScreen,
} from "../src/views.js";
import type { MobileEnrollmentPublication } from "../src/enrollment.js";

const T0 = "2026-03-01T08:00:00.000Z";
const AT = parseUtcInstant(T0);
const ACTION_ID_1 = parseDeviceActionId("00000000-0000-4000-8000-000000000001");
const ACTION_ID_2 = parseDeviceActionId("00000000-0000-4000-8000-000000000002");
const KEY_BYTES = new Uint8Array(32).fill(31);
const SIGNING_KEY = "rl114-views-test-key";

function buildShell(): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: [
      [
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "capability-probe", capability: "wifi_control", status: "available" },
        },
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: {
            kind: "capability-probe",
            capability: "esim_profile_install",
            status: "requires-permission",
          },
        },
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
        },
      ],
    ],
  });
  let counter = 0;
  return new MobileEdgeShell({
    deviceRef: "device-7f3a",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-1",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(),
    cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
    outboxKeyId: "edge-outbox-key",
    observationIdGenerator: () => deterministicUuidFromSeed(++counter),
    snapshotIdGenerator: () => deterministicUuidFromSeed(10_000 + counter),
    outboxRecordIdGenerator: () => deterministicUuidFromSeed(20_000 + counter),
    actionIdGenerator: () => deterministicUuidFromSeed(30_000 + counter),
    commandIdGenerator: () => deterministicUuidFromSeed(40_000 + counter),
    correlationIdGenerator: () => `corr-${counter}`,
    idempotencyKeyGenerator: () => `idem-${counter}`,
    desiredStateIdGenerator: () => deterministicUuidFromSeed(50_000 + counter),
    publicationIdGenerator: () => deterministicUuidFromSeed(60_000 + counter),
    signer: {
      algorithm: "hmac-sha256",
      keyId: "enrollment-rl114",
      async sign(message: string): Promise<string> {
        return createHmac("sha256", SIGNING_KEY).update(message, "utf8").digest("hex");
      },
      async verify(): Promise<boolean> {
        return true;
      },
    },
    snapshotFreshnessMs: 60_000,
  });
}

/** Renders every per-journey leg through the REAL mobileDocument shell. */
async function renderLegs(): Promise<
  readonly { readonly name: string; readonly html: string }[]
> {
  const shell = buildShell();
  await shell.runObservationCycle(T0);
  const view: MobileConnectivityView = await shell.connectivityView(T0);
  const rows = shell.capabilityMatrix(T0);
  const records = await shell.outboxRecords();
  const entries = await shell.projectionEntries();
  const publication: MobileEnrollmentPublication = await shell.enroll(T0);
  return [
    { name: "now", html: mobileDocument("Now", connectivityScreen(view)) },
    { name: "capabilities", html: mobileDocument("Capabilities", capabilityMatrixScreen(rows)) },
    {
      name: "controls (blocked, degraded)",
      html: mobileDocument(
        "Controls",
        actionOutcomeScreen(
          {
            mode: "local",
            outcome: "BLOCKED",
            result: {
              actionId: ACTION_ID_1,
              status: "degraded",
              completedAt: AT,
              reason: "capability-requires-permission",
              gateDecision: {
                decision: "degrade",
                capability: "wifi_control",
                reason: "capability-requires-permission",
                detail: "the platform requires an explicit permission grant",
                evidenceClass: "OBSERVED",
                observedAt: AT,
              },
            },
          },
          "wifi_control",
        ),
      ),
    },
    {
      name: "controls (queued, server-bound)",
      html: mobileDocument(
        "Controls",
        actionOutcomeScreen(
          {
            mode: "server",
            outcome: "QUEUED",
            result: { actionId: ACTION_ID_2, status: "accepted", completedAt: AT },
          },
          "wifi_control",
        ),
      ),
    },
    { name: "outbox", html: mobileDocument("Outbox", outboxScreen(records)) },
    { name: "action history", html: mobileDocument("History", actionHistoryScreen(entries)) },
    {
      name: "enrollment",
      html: mobileDocument("Enrollment", enrollmentScreen(publication, null)),
    },
  ];
}

// --------------------------------------------------------------------------------
// The document contract that HOLDS on the mobile surface (the mobile half of
// the §14 rules, same scanners as the web suite)
// --------------------------------------------------------------------------------

describe("RL-114 mobile document contract (every rendered leg)", () => {
  it("document basics: lang, viewport, exactly one h1, valid h1->h2->h3 hierarchy, no positive tab stops", async () => {
    for (const leg of await renderLegs()) {
      expect(leg.html, `${leg.name}: lang`).toContain('<html lang="en">');
      expect(leg.html, `${leg.name}: viewport`).toContain(
        'name="viewport" content="width=device-width, initial-scale=1"',
      );
      const h1s = (leg.html.match(/<h1[\s>]/g) ?? []).length;
      expect(h1s, `${leg.name}: exactly one h1 (the edge shell title)`).toBe(1);
      // Hierarchy: h1 first, then h2, then only +1 steps (no skips).
      const levels = [...leg.html.matchAll(/<h([1-6])(?:\s[^>]*)?>/g)].map((m) => Number(m[1]));
      expect(levels[0], `${leg.name}: first heading is the h1`).toBe(1);
      for (let i = 1; i < levels.length; i += 1) {
        const prev = levels[i - 1] ?? 0;
        const next = levels[i] ?? 0;
        expect(next, `${leg.name}: no skipped level h${prev}->h${next}`).toBeLessThanOrEqual(prev + 1);
      }
      expect(leg.html, `${leg.name}: no positive tab stops`).not.toMatch(/tabindex="[1-9]/);
      // The edge honesty footer is present on every leg.
      expect(leg.html, `${leg.name}: honesty footer`).toContain(
        "never a network authority",
      );
    }
  });

  it("fresh/stale/unknown pairing: every freshness and state badge carries its state as text", async () => {
    for (const leg of await renderLegs()) {
      for (const m of leg.html.matchAll(/<span class="badge"([^>]*)>([\s\S]*?)<\/span>/g)) {
        const attrs = m[1] ?? "";
        const text = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
        expect(text.length, `${leg.name}: badge text non-empty (${attrs.slice(0, 60)})`).toBeGreaterThan(0);
        const freshness = attrs.match(/data-freshness="([^"]+)"/)?.[1];
        if (freshness !== undefined) {
          expect(text, `${leg.name}: freshness badge carries '${freshness}' as text`).toContain(freshness);
        }
      }
    }
  });

  it("the Now leg renders the offline banner honestly: last-known state + explicit sync boundary", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    shell.enterOffline(T0);
    const view = await shell.connectivityView(T0);
    const html = mobileDocument("Now", connectivityScreen(view));
    expect(html).toContain("Offline - observation continues; queued commands are held in the encrypted outbox");
    expect(html).toContain("Connectivity (last observed):");
    expect(html).toContain("online"); // the OBSERVED last-known value, as text
    expect(html).toContain("FRESH"); // its freshness, as text
  });

  it("degraded controls pair the closed reason with visible manual guidance text", async () => {
    for (const leg of (await renderLegs()).filter((l) => l.name.startsWith("controls"))) {
      expect(leg.html, `${leg.name}: outcome as text`).toContain("Outcome:");
      expect(leg.html, `${leg.name}: honest completion instant`).toContain("Completed at:");
    }
    const blocked = (await renderLegs()).find((l) => l.name === "controls (blocked, degraded)");
    expect(blocked?.html).toContain("Manual guidance:");
    expect(blocked?.html).toContain("Grant the wifi control permission");
    expect(blocked?.html).toContain("never fakes success");
    const queued = (await renderLegs()).find((l) => l.name === "controls (queued, server-bound)");
    expect(queued?.html).toContain("queued is NOT executed");
  });
});

// --------------------------------------------------------------------------------
// The pinned contract gaps of the mobile surface (findings — recorded, not fixed)
// --------------------------------------------------------------------------------

describe("RL-114 mobile findings (pinned current behavior)", () => {
  it("FINDING RL-114-F5 (pinned): the mobile document shell lacks the web shell's a11y layer", async () => {
    for (const leg of await renderLegs()) {
      expect(leg.html, `${leg.name}: no skip link`).not.toContain("skip-link");
      expect(leg.html, `${leg.name}: no :focus-visible rule`).not.toContain(":focus-visible");
      expect(leg.html, `${leg.name}: no reduced-motion guard`).not.toContain("prefers-reduced-motion");
      expect(leg.html, `${leg.name}: no 44px touch-target floor`).not.toContain("min-height: 44px");
      expect(leg.html, `${leg.name}: no safe-area handling`).not.toContain("safe-area-inset");
      expect(leg.html, `${leg.name}: nav has no aria-label`).not.toMatch(/<nav[^>]*aria-label/);
    }
    // The fix lands these in the shell/base styles and flips every assertion
    // above (see apps/mobile/src/views.ts mobileDocument + app-kit pageShell).
  });

  it("FINDING RL-114-F6 (pinned): all four nav anchors are dead (no matching ids in any document)", async () => {
    const targets = ["now", "capabilities", "controls", "outbox"];
    for (const leg of await renderLegs()) {
      const present = [...leg.html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
      expect([...new Set(present)].sort(), `${leg.name}: nav anchor set`).toEqual([...targets].sort());
      for (const id of targets) {
        expect(leg.html, `${leg.name}: #${id} target exists`).not.toContain(`id="${id}"`);
      }
    }
  });

  it("FINDING RL-114-F7 (pinned): table header cells carry no scope and sit outside a labelled scroll region", async () => {
    for (const leg of (await renderLegs()).filter((l) =>
      ["now", "capabilities", "outbox", "action history"].includes(l.name),
    )) {
      const ths = (leg.html.match(/<th>/g) ?? []).length;
      expect(ths, `${leg.name}: bare <th> count`).toBeGreaterThan(0);
      expect(leg.html, `${leg.name}: no scope attribute`).not.toContain('scope="');
      expect(leg.html, `${leg.name}: no responsive table wrap`).not.toContain("table-wrap");
    }
  });

  it("the stale enrollment leg still renders the STALE state as text (pairing holds even on the pinned shell)", async () => {
    const shell = buildShell();
    const publication = await shell.enroll(T0);
    const html = mobileDocument(
      "Enrollment",
      enrollmentScreen(publication, {
        observedAt: publication.freshness.observedAt,
        receivedAt: publication.freshness.receivedAt,
        freshUntil: publication.freshness.freshUntil,
        freshnessState: "STALE",
      }),
    );
    expect(html).toContain("STALE");
    expect(html).toMatch(/data-freshness="STALE"[^>]*>[^<]*STALE/);
  });
});
