/**
 * Shared UI component tests (RL-060/061): freshness rendering, the mutation
 * stage pipeline (never collapsed), connectivity aggregation rendering (no
 * opaque status) and safe error panels.
 */
import { describe, expect, it } from "vitest";

import type { ConnectivityOverviewResource } from "../src/index.js";
import {
  ApiClientError,
  htmlDocument,
  connectivityOverviewSection,
  connectivitySubjectCard,
  deviceObservationCard,
  emptyState,
  errorPanel,
  freshnessBadge,
  instantView,
  moneyView,
  mutationResultPanel,
  mutationStages,
  pageShell,
  parseConnectivityOverviewResource,
  parseMutationAcknowledgement,
  severityBadge,
  stateBadge,
  type MutationFlowResult,
} from "../src/index.js";

const CONNECTIVITY_OVERVIEW: ConnectivityOverviewResource = {
  presentedAt: "2025-01-06T09:45:00.000Z",
  subjects: [
    {
      subjectType: "subscription",
      subjectId: "88888888-0000-4000-8000-000000000001",
      commercialState: "active",
      referenceStatus: "none",
      deliveryEvidenceState: "UNEVIDENCED",
      evidence: null,
    },
    {
      subjectType: "order",
      subjectId: "66666666-0000-4000-8000-000000000001",
      commercialState: "placed",
      referenceStatus: "active",
      deliveryEvidenceState: "EVIDENCED",
      evidence: {
        evidenceClass: "AUTHENTICATED_WEBHOOK",
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: "ctr_123",
        sourceVersion: 4,
        eventId: "evt_777",
        payloadDigest: "a".repeat(64),
        freshness: {
          observedAt: "2025-01-06T09:00:00.000Z",
          receivedAt: "2025-01-06T09:00:05.000Z",
          freshUntil: "2025-01-06T10:00:00.000Z",
          freshnessState: "STALE",
          recordedFreshnessState: "FRESH",
        },
      },
    },
  ],
  deviceObservations: [
    {
      deviceId: "dddddddd-0000-4000-8000-000000000001",
      deviceName: "Phone",
      capabilityFreshness: {
        observedAt: "2025-01-06T09:00:00.000Z",
        receivedAt: "2025-01-06T09:00:00.000Z",
        freshUntil: "2025-01-06T10:00:00.000Z",
        freshnessState: "FRESH",
      },
      contextFreshness: null,
      lastObservedAt: "2025-01-06T09:00:00.000Z",
    },
    {
      deviceId: "dddddddd-0000-4000-8000-000000000002",
      deviceName: "Laptop",
      capabilityFreshness: {
        observedAt: "2025-01-06T08:00:00.000Z",
        receivedAt: "2025-01-06T08:00:00.000Z",
        freshUntil: "2025-01-06T08:30:00.000Z",
        freshnessState: "STALE",
      },
      contextFreshness: {
        observedAt: null,
        receivedAt: null,
        freshUntil: null,
        freshnessState: "UNKNOWN",
      },
      lastObservedAt: "2025-01-06T08:00:00.000Z",
    },
  ],
};

function subjectAt(index: number) {
  const subject = CONNECTIVITY_OVERVIEW.subjects[index];
  if (subject === undefined) throw new Error("missing subject");
  return subject;
}
function observationAt(index: number) {
  const observation = CONNECTIVITY_OVERVIEW.deviceObservations[index];
  if (observation === undefined) throw new Error("missing observation");
  return observation;
}
function freshnessOf(index: number) {
  const freshness = observationAt(index)?.capabilityFreshness;
  if (freshness === undefined || freshness === null) throw new Error("missing freshness");
  return freshness;
}

describe("freshness rendering (RL-LOCK-010)", () => {
  it("renders FRESH, STALE and UNKNOWN distinctly with data attributes", () => {
    expect(freshnessBadge(freshnessOf(0)).html)
      .toContain('data-freshness="FRESH"');
    const stale = subjectAt(1)?.evidence?.freshness;
    expect(stale?.freshnessState).toBe("STALE");
    expect(freshnessBadge(stale ?? null).html).toContain('data-freshness="STALE"');
    const unknown = observationAt(1)?.contextFreshness;
    expect(unknown?.freshnessState).toBe("UNKNOWN");
    expect(freshnessBadge(unknown).html).toContain('data-freshness="UNKNOWN"');
    expect(freshnessBadge(null).html).toContain('data-freshness="UNKNOWN"');
  });

  it("UNKNOWN freshness renders the never-observed hint, never a guess", () => {
    const html = freshnessBadge({
      observedAt: null,
      receivedAt: null,
      freshUntil: null,
      freshnessState: "UNKNOWN",
    }).html;
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("no observation recorded");
  });
});

describe("the mutation-outcome pipeline (spec/api.md command semantics)", () => {
  const ack = parseMutationAcknowledgement({
    commandId: "00000000-0000-4000-8000-000000000001",
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    acceptedAt: "2025-01-06T09:00:00.000Z",
    executedAt: "2025-01-06T09:00:01.000Z",
  });

  it("renders all four stages as separate rows", () => {
    const html = mutationStages(ack).html;
    expect(html).toContain('data-stage="accepted"');
    expect(html).toContain('data-stage="executed"');
    expect(html).toContain('data-stage="delivered"');
    expect(html).toContain('data-stage="billable-final"');
  });

  it("unreached stages are marked, reached stages carry their timestamp", () => {
    const html = mutationStages(ack).html;
    expect(html).toContain('data-stage="accepted" data-reached="true"');
    expect(html).toContain('data-stage="executed" data-reached="true"');
    expect(html).toContain('data-stage="delivered" data-reached="false"');
    expect(html).toContain('data-stage="billable-final" data-reached="false"');
    expect(html).toContain("(not reached yet)");
  });

  it("never collapses the stages into a single status", () => {
    const html = mutationStages(ack).html;
    expect(html).not.toMatch(/data-status=/);
    expect(html).not.toMatch(/status="(?:accepted|executed|delivered|billable-final)"/);
  });

  it("the result panel routes success and failure", () => {
    const ok: MutationFlowResult = { status: "ok", acknowledgement: ack };
    expect(mutationResultPanel(ok).html).toContain('data-mutation-result="ok"');
    const error: MutationFlowResult = {
      status: "error",
      error: new ApiClientError({
        kind: "conflict",
        reason: "OPTIMISTIC_VERSION_CONFLICT",
        message: "changed concurrently",
        retryable: false,
        status: 409,
      }),
    };
    const panel = mutationResultPanel(error).html;
    expect(panel).toContain('data-mutation-result="error"');
    expect(panel).toContain("OPTIMISTIC_VERSION_CONFLICT");
  });
});

describe("connectivity aggregation rendering", () => {
  const overview = parseConnectivityOverviewResource(CONNECTIVITY_OVERVIEW);

  it("renders the underlying states side by side with no combined status", () => {
    const html = connectivityOverviewSection(overview).html;
    expect(html).toContain('data-connectivity-overview="true"');
    expect(html).toContain('data-presented-at="2025-01-06T09:45:00.000Z"');
    expect(html).toContain('data-evidence="UNEVIDENCED"');
    expect(html).toContain('data-evidence="EVIDENCED"');
    expect(html).toContain('data-freshness="STALE"');
    expect(html).toContain('data-state="active"');
    expect(html).toContain('data-state="placed"');
    expect(html).not.toMatch(/combinedStatus|overallStatus|connectivityStatus/);
  });

  it("the subject card shows commercial state, reference lifecycle and evidence facts", () => {
    const subject = overview.subjects[1];
    expect(subject).toBeDefined();
    const html = connectivitySubjectCard(subject ?? subjectAt(0)).html;
    expect(html).toContain("Commercial state:");
    expect(html).toContain("Reference:");
    expect(html).toContain("Delivery evidence:");
    expect(html).toContain("ctr_123");
    expect(html).toContain("recorded as FRESH when linked");
  });

  it("the unevidenced subject explicitly says no evidence is linked", () => {
    const html = connectivitySubjectCard(subjectAt(0)).html;
    expect(html).toContain('data-evidence-present="false"');
    expect(html).toContain("No delivery evidence is linked");
  });

  it("device observations render capability and context freshness separately", () => {
    const html = deviceObservationCard(observationAt(1)).html;
    expect(html).toContain("Capability snapshot:");
    expect(html).toContain("Context snapshot:");
    expect(html).toContain('data-freshness="STALE"');
    expect(html).toContain('data-freshness="UNKNOWN"');
    expect(html).toContain("Last observed: 2025-01-06T08:00:00.000Z");
  });
});

describe("safe rendering (RL-LOCK-016 spirit)", () => {
  it("escapes text content", () => {
    const html = errorPanel(
      new ApiClientError({
        kind: "validation",
        reason: "XSS_PROBE",
        message: "<script>alert(1)</script>",
        retryable: false,
        status: 400,
      }),
    ).html;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("unknown errors are reduced to a generic sentence", () => {
    const html = errorPanel(new Error("password=hunter2 at postgres://admin")).html;
    expect(html).not.toContain("hunter2");
    expect(html).toContain("details suppressed");
  });
});

describe("deterministic formatting primitives", () => {
  it("money renders integer minor units, never floats", () => {
    expect(moneyView({ amountMinor: 1999, currency: "USD" }).html).toBe("19.99 USD");
    expect(moneyView({ amountMinor: 505, currency: "EUR" }).html).toBe("5.05 EUR");
    expect(moneyView({ amountMinor: 100, currency: "JPY" }).html).toBe("1.00 JPY");
  });

  it("instants render verbatim and missing instants render not-recorded", () => {
    expect(instantView("2025-01-06T09:00:00.000Z").html).toBe("2025-01-06T09:00:00.000Z");
    expect(instantView(null).html).toContain("not recorded");
  });

  it("badges carry data attributes for test targeting", () => {
    expect(stateBadge("placed").html).toContain('data-state="placed"');
    expect(severityBadge("critical").html).toContain('data-severity="critical"');
  });

  it("empty states and the page shell render", () => {
    expect(emptyState("devices").html).toContain("No devices to show.");
    const shell = pageShell({
      appTitle: "RoamLink",
      navLinks: [{ label: "Home", href: "/" }],
      main: emptyState("content"),
      footerNote: "apps hold no authority",
    });
    const document = htmlDocument("RoamLink", shell);
    expect(document.html).toContain("<!DOCTYPE html>");
    expect(shell.html).toContain("<header");
    expect(shell.html).toContain("<footer");
  });
});
