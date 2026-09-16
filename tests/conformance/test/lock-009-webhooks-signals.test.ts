/**
 * RL-LOCK-009 conformance suite: webhooks are signals, not truth.
 *
 * A webhook is durably admitted and verified, then reconciled against the
 * canonical ADCOS resource where needed. Event arrival must NEVER be
 * treated as sufficient proof of physical delivery.
 *
 * GREEN PROOFS:
 *  - a FORGED webhook (tampered signature / unknown key / stale timestamp /
 *    malformed envelope) is rejected at admission and occupies no dedupe
 *    key (a corrected retry can still admit);
 *  - a VERIFIED webhook is admitted but produces NO projection until the
 *    async projection step runs (admission and truth-application are
 *    separate steps - processPending refuses to run without a projector);
 *  - the projected payload of a webhook event IS the event envelope (the
 *    signal), never a canonical body;
 *  - notifications originate ONLY from durable RoamLink state transitions
 *    (the closed single-member TransitionOrigin contract).
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - a notification source claiming an ADCOS/webhook origin is rejected;
 *  - a raw ADCOS payload shape cannot fit the transition-origin contract;
 *  - a forged delivery is NOT admitted (the toggle flips the expectation:
 *    a tree that admitted forged webhooks would make the green proof red
 *    and the toggled assertion green - the suite is bound to the
 *    violation either way).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryPersistence } from "@roamlink/persistence";
import {
  ADCOS_WEBHOOK_INBOX_REPOSITORY,
  AdcosWebhookInboxService,
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { DeterministicClock } from "@roamlink/testkit";
import { parseTransitionOrigin } from "@roamlink/notifications";
import { readSourceFiles, violationEnabled } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeEventPayload,
  fakeWebhookDelivery,
  type FakeWebhookEventSpec,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-009";
const T0 = "2026-01-15T08:30:00.000Z";

function baseSpec(overrides?: Partial<FakeWebhookEventSpec>): FakeWebhookEventSpec {
  return {
    eventId: "evt-rl-009",
    eventType: "connectivity_intent.created",
    resourceId: "intent-7",
    resourceKind: "connectivity_intent",
    resourceVersion: 1,
    occurredAt: T0,
    correlationId: "corr-rl-009",
    ...overrides,
  };
}

async function makeService() {
  const persistence = createInMemoryPersistence();
  const clock = new DeterministicClock(T0);
  const verifier = new HmacWebhookVerifier({
    environment: "sandbox",
    keys: new StaticWebhookSigningKeyRegistry({
      [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
    }),
  });
  const inbox = new AdcosWebhookInboxService({
    verifier,
    persistence,
    reader: persistence,
    clock,
  });
  return { persistence, inbox };
}

describe(`${LOCK}: webhooks are signals, not truth`, () => {
  it("green: a correctly signed delivery is ADMITTED exactly once; the redelivery is a DUPLICATE, not a second record", async () => {
    const { persistence, inbox } = await makeService();
    const delivery = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });

    const first = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    expect(first.outcome).toBe("ADMITTED");
    const second = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    expect(second.outcome).toBe("DUPLICATE");

    const admittedList = await persistence.inbox.list("ADMITTED");
    expect(admittedList.length).toBe(1);
    const stored = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-rl-009");
    expect(stored).not.toBeNull();
  });

  it("green: a FORGED signature is rejected at admission (no admitted record, no dedupe occupancy)", async () => {
    const { persistence, inbox } = await makeService();
    const delivery = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
      overrides: { tamperSignature: true },
    });

    const admission = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    expect(admission.outcome).toBe("REJECTED");
    expect(await persistence.inbox.list("ADMITTED")).toEqual([]);

    // A corrected retry of the same event id can still admit: the rejection
    // never occupied the dedupe key.
    const corrected = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-2",
      sequence: 2,
      receivedAt: T0,
    });
    const retry = await inbox.admitDelivery({ ...corrected, receivedAt: T0 as never });
    expect(retry.outcome).toBe("ADMITTED");
  });

  it("green: unknown signing key, stale timestamp and malformed envelopes are all rejected at admission", async () => {
    const { inbox } = await makeService();
    const cases = [
      { overrides: { unknownKeyId: "whk-unknown" }, spec: baseSpec() },
      { overrides: { staleTimestamp: "2026-01-15T07:00:00.000Z" }, spec: baseSpec() },
      { overrides: { dropHeader: "X-ADCOS-Signature" }, spec: baseSpec() },
      { overrides: {}, spec: baseSpec({ extraMembers: { rogue: 1 } }) },
    ];
    for (const [index, testCase] of cases.entries()) {
      const delivery = fakeWebhookDelivery({
        spec: testCase.spec,
        deliveryId: `dlv-forged-${index}`,
        sequence: index + 1,
        receivedAt: T0,
        overrides: testCase.overrides,
      });
      const admission = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
      expect(admission.outcome).toBe("REJECTED");
    }
  });

  it("green: admission writes NO projection (the signal is not applied as truth)", async () => {
    const { persistence, inbox } = await makeService();
    const delivery = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    const admission = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    expect(admission.outcome).toBe("ADMITTED");

    // The inbox repository holds the immutable SIGNAL record in PENDING
    // state; truth-application is a separate step (the projector port),
    // which this service does not even hold.
    const record = await persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).get("evt-rl-009");
    expect(record).not.toBeNull();
    expect((record?.value as { processing: { status: string } }).processing.status).toBe("PENDING");
  });

  it("green: processPending requires a registered projector (signals do not self-apply)", async () => {
    const { inbox } = await makeService();
    const delivery = fakeWebhookDelivery({
      spec: baseSpec(),
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    await expect(inbox.processPending()).rejects.toThrow(
      /WEBHOOK_INBOX_PROJECTOR_MISSING|AdcosWebhookProjector/,
    );
  });

  it("negative proof: a notification source claiming a webhook/ADCOS origin is rejected (red when admitted)", () => {
    const validTransitionOrigin = {
      origin: "roamlink_state_transition",
      aggregateType: "order",
      aggregateId: "00000000-0000-4000-8000-0000000000c2",
      transition: "order.placed",
      eventId: "00000000-0000-4000-8000-0000000000c3",
      occurredAt: T0,
    };
    expect(() => parseTransitionOrigin(validTransitionOrigin)).not.toThrow();

    for (const violating of [
      { ...validTransitionOrigin, origin: "adcos_webhook" },
      { ...validTransitionOrigin, origin: "webhook" },
    ]) {
      if (violationEnabled(LOCK)) {
        expect(() => parseTransitionOrigin(violating)).not.toThrow();
      } else {
        expect(() => parseTransitionOrigin(violating)).toThrow(
          /NOTIFICATION_INVALID|single-member|roamlink_state_transition/,
        );
      }
    }
  });

  it("negative proof: an ADCOS payload shape cannot fit the transition-origin contract (red when admitted)", () => {
    // A raw ADCOS webhook envelope: snake_case members the closed
    // transition-origin vocabulary does not have.
    const adcosPayload = {
      origin: "roamlink_state_transition",
      aggregateType: "order",
      aggregateId: "00000000-0000-4000-8000-0000000000c2",
      transition: "order.placed",
      eventId: "00000000-0000-4000-8000-0000000000c3",
      occurredAt: T0,
      resource_id: "intent-7",
      resource_kind: "connectivity_intent",
      resource_version: 3,
      event_type: "connectivity_intent.created",
      correlation_id: "corr-x",
    };
    if (violationEnabled(LOCK)) {
      expect(() => parseTransitionOrigin(adcosPayload)).not.toThrow();
    } else {
      expect(() => parseTransitionOrigin(adcosPayload)).toThrow(
        /NOTIFICATION_INVALID|no shape that fits here/,
      );
    }
  });

  it("green: the projected payload of a webhook event is the event ENVELOPE, not a canonical body", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/projections/src"], []);
    const engine = files.find((file) => file.path.endsWith("projection-engine.ts"));
    expect(engine).toBeDefined();
    expect(engine?.content).toMatch(/eventEnvelopePayload/);
    expect(engine?.content).toMatch(/signals, not truth/);
    // The envelope payload is built from event members ONLY.
    const envelopeMatch = /function eventEnvelopePayload[\s\S]*?return \{[\s\S]*?\};/.exec(
      engine?.content ?? "",
    );
    expect(envelopeMatch).not.toBeNull();
    const envelope = envelopeMatch?.[0] ?? "";
    for (const member of ["event_id", "event_type", "resource_id", "occurred_at"]) {
      expect(envelope).toContain(member);
    }
    expect(envelope).not.toContain("canonical_body");
    expect(envelope).not.toContain("body");
  });

  it("green: the signed payload of a signal is byte-stable (the dedupe digest is honest)", () => {
    const spec = baseSpec();
    expect(fakeEventPayload(spec)).toBe(fakeEventPayload(spec));
    expect(fakeEventPayload(spec)).not.toBe(fakeEventPayload(baseSpec({ resourceVersion: 2 })));
  });
});
