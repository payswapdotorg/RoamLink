import { describe, expect, it } from "vitest";
import { DomainError, UnknownStateError, canonicalizeJson, parseUtcInstant } from "@roamlink/contracts";
import { DeterministicClock, DeterministicUuidGenerator, fixtureTenantId } from "@roamlink/testkit";
import { AdcosApiError } from "@roamlink/adcos";
import {
  AdcosCompatibilityState,
  AdcosIntentAdapter,
  retryIntentCommand,
  runAdcosCompatibilityCheck,
  retryMetadataFor,
  type IntentCommandInput,
} from "../src/index.js";
import type { RoamLinkError } from "@roamlink/contracts";
import { FakeAdcos } from "./fake-adcos.js";

const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");

function intentInput(): IntentCommandInput {
  return {
    sourceIntentId: "00000000-0000-4000-8000-000000000101",
    sourceIntentVersionId: "00000000-0000-4000-8000-000000000102",
    sourceIntentVersionNumber: 1,
    actorId: "actor-1",
    tenantId: fixtureTenantId({ seed: 5 }),
    requirements: [
      { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
      { dimension: "reliability", classification: "soft", statement: { level: "high" } },
    ],
    validity: { start: T0, end: parseUtcInstant("2026-01-29T08:30:00.000Z") },
    termination: { actor: "customer", onExpiry: "release" },
  };
}

function makeAdapter(fake: FakeAdcos) {
  const clock = new DeterministicClock(T0);
  const adapter = new AdcosIntentAdapter({
    client: fake,
    clock,
    commandIds: new DeterministicUuidGenerator(1),
    compatibility: new AdcosCompatibilityState(),
  });
  return { clock, adapter };
}

describe("intent submission through the client seam (RL-031)", () => {
  it("submits a compiled draft and returns the ADCOS document + envelope", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const before = fake.intentCount();
    const submission = await adapter.submit(intentInput());
    expect(fake.intentCount()).toBe(before + 1);
    expect((submission.document as Record<string, unknown>)["id"]).toMatch(/^intent-/);
    expect(submission.envelope.idempotencyKey).toMatch(/^idem\.intent\./);
    expect(submission.attempt).toBe(1);
  });

  it("mutations fail closed BEFORE the gate passes (§9 default unknown)", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await expect(adapter.submit(intentInput())).rejects.toMatchObject({
      kind: "domain",
      reason: "ADCOS_COMPATIBILITY_GATE_UNVERIFIED",
    });
    expect(fake.intentCount()).toBe(1); // only the seeded probe intent
  });

  it("mutations fail closed when the gate reports incompatible (§9)", async () => {
    const fake = new FakeAdcos({ apiVersion: "3.0" as never });
    const { adapter } = makeAdapter(fake);
    const report = await adapter.runCompatibilityCheck(undefined, T0);
    expect(report.status).toBe("incompatible");
    await expect(adapter.submit(intentInput())).rejects.toMatchObject({
      kind: "domain",
      reason: "ADCOS_COMPATIBILITY_GATE_CLOSED",
    });
  });

  it("reads stay available (diagnosable) while the gate is unverified", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    const probe = fake.probeRefs;
    expect(probe).not.toBeNull();
    const document = await adapter.getIntent(probe?.intentId as string);
    expect((document as Record<string, unknown>)["id"]).toBe(probe?.intentId);
    const lifecycle = await adapter.getIntentLifecycle(probe?.intentId as string);
    expect((lifecycle as Record<string, unknown>)["intent_id"]).toBe(probe?.intentId);
  });
});

describe("retry safety after timeout / connection loss / duplicate delivery (RL-031 §5, RL-LOCK-014)", () => {
  it("timeout after dispatch: outcome unknown, retry replays the SAME document, exactly ONE intent", async () => {
    const fake = new FakeAdcos();
    const { clock, adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const input = intentInput();
    const draft = adapter.compile(input);
    const before = fake.intentCount();

    // The fake applies the mutation and THEN loses the response (post fault).
    fake.failNext({ kind: "transport", outcome: "unknown" }, { phase: "post" });
    let timeoutError: unknown;
    try {
      await adapter.submitDraft(draft);
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toBeInstanceOf(UnknownStateError);
    expect((timeoutError as UnknownStateError).reason).toBe("ADCOS_TIMEOUT_OUTCOME_UNKNOWN");
    expect((timeoutError as UnknownStateError).retryable).toBe(true);
    // The mutation WAS applied server-side (unknown outcome, post fault).
    expect(fake.intentCount()).toBe(before + 1);

    // The safe retry: same key, bumped attempt metadata.
    clock.advanceBy(1_000);
    const retryDraft = retryIntentCommand(
      draft,
      input,
      retryMetadataFor(timeoutError as RoamLinkError, clock.now()),
    );
    const submission = await adapter.submitDraft(retryDraft);
    expect(fake.intentCount()).toBe(before + 1); // STILL exactly one intent
    expect(submission.attempt).toBe(2);
    expect(submission.envelope.idempotencyKey).toBe(draft.envelope.idempotencyKey);
    expect((submission.document as Record<string, unknown>)["id"]).toMatch(/^intent-/);
  });

  it("connection loss before send: unavailable, retry creates exactly one intent", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const input = intentInput();
    const draft = adapter.compile(input);
    const before = fake.intentCount();

    fake.failNext({ kind: "transport", outcome: "not-sent" }, { phase: "pre" });
    await expect(adapter.submitDraft(draft)).rejects.toMatchObject({
      kind: "unavailable",
      reason: "ADCOS_TRANSPORT_UNAVAILABLE",
    });
    expect(fake.intentCount()).toBe(before); // not applied

    const submission = await adapter.submitDraft(draft);
    expect(fake.intentCount()).toBe(before + 1);
    expect(submission.attempt).toBe(1);
  });

  it("duplicate delivery of the same draft is absorbed (same key, same document)", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const before = fake.intentCount();
    const draft = adapter.compile(intentInput());
    const first = await adapter.submitDraft(draft);
    const second = await adapter.submitDraft(draft);
    expect(fake.intentCount()).toBe(before + 1); // exactly one submitted intent
    expect(canonicalizeJson(second.document)).toBe(canonicalizeJson(first.document));
    expect(second.envelope.idempotencyKey).toBe(first.envelope.idempotencyKey);
  });

  it("resubmit uses the retry pipeline end-to-end", async () => {
    const fake = new FakeAdcos();
    const { clock, adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const afterGate = fake.intentCount();
    const input = intentInput();
    const draft = adapter.compile(input);
    fake.failNext({ kind: "transport", outcome: "unknown" }, { phase: "post" });
    const error = await adapter.submitDraft(draft).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownStateError);
    clock.advanceBy(5_000);
    const submission = await adapter.resubmit(draft, input, {
      reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN",
      kind: "unknown-state",
      occurredAt: clock.now(),
    });
    expect(submission.attempt).toBe(2);
    expect(fake.intentCount()).toBe(afterGate + 1); // gate probe + one submitted intent
  });
});

describe("closed error adaptation on the intent surface (RL-031)", () => {
  it("maps transient ADCOS rate-limited onto the RoamLink rate-limited kind", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    fake.failNext({ kind: "adcos-error", code: "rate-limited" });
    await expect(adapter.submitDraft(adapter.compile(intentInput()))).rejects.toMatchObject({
      kind: "rate-limited",
      reason: "ADCOS_RATE_LIMITED",
      retryable: true,
    });
  });

  it("maps ADCOS store-failed onto the RoamLink unavailable kind", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    fake.failNext({ kind: "adcos-error", code: "store-failed" });
    await expect(adapter.submitDraft(adapter.compile(intentInput()))).rejects.toMatchObject({
      kind: "unavailable",
      reason: "ADCOS_STORE_FAILED",
      retryable: true,
    });
  });

  it("maps resource-unknown reads onto the RoamLink not-found kind", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await expect(adapter.getIntent("intent-does-not-exist")).rejects.toMatchObject({
      kind: "not-found",
      reason: "ADCOS_RESOURCE_UNKNOWN",
    });
  });

  it("maps idempotency-conflict onto the RoamLink conflict kind (client seam)", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    await adapter.runCompatibilityCheck(fake.probeRefs ?? undefined, T0);
    const draft = adapter.compile(intentInput());
    await adapter.submitDraft(draft);
    // Same key, DIFFERENT payload -> ADCOS answers idempotency-conflict
    // (the closed error adaptation to the conflict kind is covered in
    // error-mapping.test.ts; here we prove the seam behavior).
    const changed = adapter.compile({
      ...intentInput(),
      requirements: [
        { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
      ],
    });
    await expect(
      fake.createIntent(changed.request, { idempotencyKey: draft.envelope.idempotencyKey }),
    ).rejects.toMatchObject({ code: "idempotency-conflict" });
  });

  it("retryMetadataFor extracts log-safe retry bookkeeping", () => {
    const fake = new FakeAdcos();
    const { clock, adapter } = makeAdapter(fake);
    void fake;
    void adapter;
    const error = new DomainError("boom", { reason: "ADCOS_STORE_FAILED" });
    const metadata = retryMetadataFor(error, clock.now());
    expect(metadata).toEqual({
      reason: "ADCOS_STORE_FAILED",
      kind: "domain",
      occurredAt: T0,
    });
  });

  it("the client seam rejects unkeyed mutations (RL-LOCK-014 at the seam)", async () => {
    const fake = new FakeAdcos();
    await expect(
      fake.createIntent(
        {
          requirements: [],
          validity: { start: T0, end: "2026-01-16T08:30:00.000Z" },
          termination: { actor: "customer", on_expiry: "release" },
          recorded_at: T0,
        },
        undefined as never,
      ),
    ).rejects.toBeInstanceOf(AdcosApiError);
  });
});

describe("compatibility gate behavior on the intent surface (§9)", () => {
  it("runAdcosCompatibilityCheck passes on a healthy fake and unblocks mutations", async () => {
    const fake = new FakeAdcos();
    const { adapter } = makeAdapter(fake);
    const report = await runAdcosCompatibilityCheck(fake, adapter.compatibility, {
      ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}),
      at: T0,
    });
    expect(report.status).toBe("compatible");
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    const submission = await adapter.submit(intentInput());
    expect(submission.document).toBeDefined();
  });

  it("the gate's idempotency probe replays through the fake (v2 behavior)", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const state = new AdcosCompatibilityState();
    const report = await runAdcosCompatibilityCheck(fake, state, { at: T0 });
    expect(report.status).toBe("compatible");
    const idempotencyCheck = report.checks.find((c) => c.name === "idempotency_behavior.replay");
    expect(idempotencyCheck?.passed).toBe(true);
    // one probe intent, replayed once - never two
    expect(fake.intentCount()).toBe(1);
  });
});
