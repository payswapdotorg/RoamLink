/**
 * The ADCOS compatibility suite (RL-036, spec/adcos-integration.md §9).
 *
 * Proves the gate PASSES on the supported version and FAILS CLOSED on:
 * version mismatch, missing endpoints, missing lifecycle states, missing
 * required fields, bad webhook semantics and broken idempotency behavior -
 * with a diagnosable health state every time (RL-LOCK-016 value-free).
 */
import { describe, expect, it } from "vitest";
import { DomainError, parseUtcInstant, SUPPORTED_ADCOS_API_VERSIONS, type UtcInstant } from "@roamlink/contracts";
import { ADCOS_API_VERSION, type AdcosClient, type AdcosWebhookEvent } from "@roamlink/adcos";
import { AdcosCompatibilityState } from "@roamlink/integration";
import { FakeAdcos } from "../../integration/test/fake-adcos.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../webhook-inbox/test/fake-adcos-webhooks.js";
import {
  runAdcosCompatibilitySuite,
  SUITE_SUPPORTED_ADCOS_VERSION,
  ADCOS_COMPATIBILITY_SUITE_VERSION,
  suiteReportAsGateReport,
  type AdcosCompatibilitySuiteReport,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";

const SAMPLE_EVENT = {
  event_id: "evt-suite-sample",
  event_type: "connectivity_intent.created",
  resource_id: "intent-suite-sample",
  resource_kind: "connectivity_intent",
  resource_version: 1,
  occurred_at: parseUtcInstant(T0),
  api_version: ADCOS_API_VERSION,
  environment: "sandbox",
  correlation_id: "corr-suite-sample",
} as AdcosWebhookEvent;

function webhookProbe(fake: FakeAdcos): {
  environment: "sandbox";
  keys: Record<string, string>;
  sampleEvent: AdcosWebhookEvent;
  signingKeyId: string;
  signingSecret: string;
  sampleDelivery: { headers: Record<string, string>; payload: string };
} {
  const emitted = fake.emittedEvents()[0];
  const sample = emitted?.event ?? SAMPLE_EVENT;
  const occurredAt = (emitted?.event.occurred_at ?? SAMPLE_EVENT.occurred_at) as string;
  const signed = fakeWebhookDelivery({
    spec: {
      eventId: sample.event_id,
      eventType: sample.event_type,
      resourceId: sample.resource_id,
      resourceKind: sample.resource_kind,
      resourceVersion: sample.resource_version,
      occurredAt,
      correlationId: sample.correlation_id,
      environment: "sandbox",
    },
    deliveryId: "dlv-suite-server-sample",
    sequence: 1,
    receivedAt: T0,
  });
  return {
    environment: "sandbox",
    keys: { [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET },
    sampleEvent: sample,
    signingKeyId: TEST_SIGNING_KEY_ID,
    signingSecret: TEST_SIGNING_SECRET,
    sampleDelivery: { headers: signed.headers, payload: signed.payload },
  };
}

function seededFake(): FakeAdcos {
  const fake = new FakeAdcos({ now: () => parseUtcInstant(T0) as UtcInstant });
  if (fake.probeRefs === null) throw new Error("test expected the seeded probe refs");
  return fake;
}

async function runSuite(
  fake: FakeAdcos,
  options: { state?: AdcosCompatibilityState; webhookSemantics?: boolean; at?: string } = {},
): Promise<AdcosCompatibilitySuiteReport> {
  const probeRefs = fake.probeRefs;
  return await runAdcosCompatibilitySuite({
    client: fake,
    ...(probeRefs !== null ? { probe: { ...probeRefs } } : {}),
    ...(options.webhookSemantics === false ? {} : { webhookSemantics: webhookProbe(fake) }),
    at: options.at ?? T0,
    ...(options.state !== undefined ? { state: options.state } : {}),
  });
}

describe("the compatibility suite passes on the supported version (§9)", () => {
  it("a healthy ADCOS (the fake, pinned 2.0) is COMPATIBLE end to end", async () => {
    const fake = seededFake();
    const state = new AdcosCompatibilityState();
    const report = await runSuite(fake, { state });

    expect(report.status).toBe("compatible");
    expect(report.at).toBe(T0);
    expect(report.suiteVersion).toBe(ADCOS_COMPATIBILITY_SUITE_VERSION);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(state.status()).toBe("compatible");
    expect(() => state.assertMutationsAllowed()).not.toThrow();

    const names = report.checks.map((check) => check.name);
    // The Wave-2 gate checks are composed in...
    for (const name of [
      "application_self.available",
      "intent_get.available",
      "intent_lifecycle_get.available",
      "contract_get.available",
      "contract_usage_get.available",
      "lease_get.available",
      "contract_lifecycle_states.required",
      "request_schemas.closed",
      "webhook_envelope.closed",
      "webhook_signature_semantics.pinned",
      "idempotency_behavior.replay",
    ]) {
      expect(names).toContain(name);
    }
    // ...and the suite's own checks extend them.
    for (const name of [
      "version_pin.single_site",
      "lifecycle_state_vocabulary.server",
      "document_required_fields.resource_version",
      "webhook_verifier_semantics.accepts_valid",
      "webhook_verifier_semantics.rejects_tampered_signature",
      "webhook_verifier_semantics.rejects_stale_timestamp",
      "webhook_verifier_semantics.rejects_unknown_key",
      "webhook_signature_semantics.hmac_known_answer",
      "webhook_delivery_verifies.server",
      "mutation_gate.fail_closed",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("the supported version is configured in ONE place (single-site pin)", () => {
    expect(SUITE_SUPPORTED_ADCOS_VERSION).toBe(ADCOS_API_VERSION);
    expect(SUITE_SUPPORTED_ADCOS_VERSION).toBe(SUPPORTED_ADCOS_API_VERSIONS[0]);
    expect(SUITE_SUPPORTED_ADCOS_VERSION).toBe("2.0");
    expect(SUPPORTED_ADCOS_API_VERSIONS).toHaveLength(1);
  });

  it("the report converts to the diagnosable gate health report", async () => {
    const fake = seededFake();
    const report = await runSuite(fake);
    const gateReport = suiteReportAsGateReport(report);
    expect(gateReport.status).toBe("compatible");
    expect(gateReport.at).toBe(report.at);
    expect(gateReport.checks).toBe(report.checks);
    const state = new AdcosCompatibilityState();
    state.apply(gateReport);
    expect(state.latest()?.status).toBe("compatible");
  });
});

describe("the compatibility suite FAILS CLOSED (§9)", () => {
  it("a version-mismatched ADCOS is incompatible and mutations are refused", async () => {
    const fake = new FakeAdcos({ apiVersion: "3.0" as never, now: () => parseUtcInstant(T0) as UtcInstant });
    const state = new AdcosCompatibilityState();
    const report = await runSuite(fake, { state });

    expect(report.status).toBe("incompatible");
    const versionCheck = report.checks.find((c) => c.name === "application_self.available");
    expect(versionCheck?.passed).toBe(false);
    expect(versionCheck?.code).toBe("ADCOS_VERSION_UNSUPPORTED");
    expect(state.status()).toBe("incompatible");

    expect(() => state.assertMutationsAllowed()).toThrow(DomainError);
    try {
      state.assertMutationsAllowed();
    } catch (error) {
      expect((error as DomainError).reason).toBe("ADCOS_COMPATIBILITY_GATE_CLOSED");
      expect((error as DomainError).message).toContain("application_self.available"); // diagnosable
    }
  });

  it("an UNVERIFIED gate state refuses mutations by default (fail-closed)", () => {
    const state = new AdcosCompatibilityState();
    expect(state.status()).toBe("unknown");
    expect(() => state.assertMutationsAllowed()).toThrow(DomainError);
    try {
      state.assertMutationsAllowed();
    } catch (error) {
      expect((error as DomainError).reason).toBe("ADCOS_COMPATIBILITY_GATE_UNVERIFIED");
    }
  });

  it("missing endpoints (routes disabled) fail the suite with route-unknown", async () => {
    const fake = seededFake();
    fake.disableRoute("intent_get");
    const report = await runSuite(fake);
    expect(report.status).toBe("incompatible");
    const endpointCheck = report.checks.find((c) => c.name === "intent_get.available");
    expect(endpointCheck?.passed).toBe(false);
    expect(endpointCheck?.code).toBe("route-unknown");
  });

  it("missing lifecycle states (a foreign server vocabulary) fail the suite", async () => {
    const fake = seededFake();
    const intentId = fake.probeRefs?.intentId;
    if (intentId === undefined) throw new Error("test expected the probe intent");
    fake.overrideIntentLifecycleState(intentId, "SUPER_ACTIVE"); // not in the pinned 13

    const report = await runSuite(fake);
    expect(report.status).toBe("incompatible");
    const lifecycleCheck = report.checks.find((c) => c.name === "lifecycle_state_vocabulary.server");
    expect(lifecycleCheck?.passed).toBe(false);
    expect(lifecycleCheck?.code).toBe("ADCOS_CONTRACT_STATE_INVALID");
  });

  it("missing required fields (no resource_version) fail the suite", async () => {
    const fake = seededFake();
    fake.stripResourceVersions();
    const report = await runSuite(fake);
    expect(report.status).toBe("incompatible");
    const fieldsCheck = report.checks.find((c) => c.name === "document_required_fields.resource_version");
    expect(fieldsCheck?.passed).toBe(false);
    expect(fieldsCheck?.code).toBe("ADCOS_DOCUMENT_FIELDS_MISSING");
  });

  it("bad webhook semantics (a server delivery that does not verify) fail the suite", async () => {
    const fake = seededFake();
    const probe = webhookProbe(fake);
    const tampered = {
      environment: probe.environment,
      keys: probe.keys,
      sampleEvent: probe.sampleEvent,
      signingKeyId: probe.signingKeyId,
      signingSecret: probe.signingSecret,
      sampleDelivery: {
        headers: {
          ...probe.sampleDelivery.headers,
          "X-ADCOS-Signature": `00${probe.sampleDelivery.headers["X-ADCOS-Signature"]?.slice(2) ?? ""}`,
        },
        payload: probe.sampleDelivery.payload,
      },
    };
    const probeRefs = fake.probeRefs;
    const report = await runAdcosCompatibilitySuite({
      client: fake,
      ...(probeRefs !== null ? { probe: { ...probeRefs } } : {}),
      webhookSemantics: tampered,
      at: T0,
    });
    expect(report.status).toBe("incompatible");
    const deliveryCheck = report.checks.find((c) => c.name === "webhook_delivery_verifies.server");
    expect(deliveryCheck?.passed).toBe(false);
    expect(deliveryCheck?.code).toBe("ADCOS_WEBHOOK_DELIVERY_UNVERIFIED");
    expect(deliveryCheck?.detail).toContain("webhook-signature-invalid"); // the underlying closed code
  });

  it("broken idempotency behavior (same key, different responses) fails the suite", async () => {
    const fake = seededFake();
    const seen = new Set<string>();
    const broken: AdcosClient = new Proxy(fake, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "createIntent" && typeof value === "function") {
          return async (request: never, mutation: { idempotencyKey: string }) => {
            const first = !seen.has(mutation.idempotencyKey);
            seen.add(mutation.idempotencyKey);
            const document = await (
              value as (r: never, m: never) => Promise<Record<string, unknown>>
            ).apply(target, [request, mutation as never]);
            if (!first) {
              return { ...document, resource_version: 9999 };
            }
            return document;
          };
        }
        return value;
      },
    }) as AdcosClient;

    const probeRefs = fake.probeRefs;
    const report = await runAdcosCompatibilitySuite({
      client: broken,
      ...(probeRefs !== null ? { probe: { ...probeRefs } } : {}),
      webhookSemantics: webhookProbe(fake),
      at: T0,
    });
    expect(report.status).toBe("incompatible");
    const idempotencyCheck = report.checks.find((c) => c.name === "idempotency_behavior.replay");
    expect(idempotencyCheck?.passed).toBe(false);
    expect(idempotencyCheck?.code).toBe("ADCOS_IDEMPOTENCY_CONFLICT");
  });

  it("transient failures during the suite surface as failed checks, not crashes", async () => {
    const fake = seededFake();
    fake.failNext({ kind: "adcos-error", code: "rate-limited" }, { count: 1 });
    const report = await runSuite(fake);
    expect(report.status).toBe("incompatible");
    const failed = report.checks.find((c) => !c.passed);
    expect(failed?.code).toBe("rate-limited");
  });

  it("the report is diagnosable and value-free (RL-LOCK-016: no secrets)", async () => {
    const fake = seededFake();
    const report = await runSuite(fake);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(TEST_SIGNING_SECRET);
    expect(serialized).not.toContain("signingSecret");
  });
});
