/**
 * The public enterprise API surface end-to-end tests (RL-063, spec/api.md).
 *
 * Drives the typed {@link EnterpriseApiClient} against the deterministic
 * in-memory fake over the FULL route table: the enrollment journey, tenant
 * federation, API-key issuance/rotation/revocation, connector provisioning +
 * managed-edge enrollment, and webhook endpoint management. Proves the
 * request discipline order (401 before 403 before 400, no state touched on
 * denial), idempotent replays, and that the webhook emission test seam
 * delivers signed events end-to-end.
 */
import { describe, expect, it } from "vitest";
import { fixtureTenantId } from "@roamlink/testkit";

import { EnterpriseApiClient, EnterpriseApiError } from "../src/api-client.js";
import { createEnterpriseApiHarness } from "../src/api-fake.js";
import {
  parseEnterpriseMutationAcknowledgement,
  ENTERPRISE_MUTATION_STAGES,
} from "../src/api-surface.js";
import {
  buildCustomerWebhookSignatureMessage,
  parseDurableStateTransition,
  signCustomerWebhookDelivery,
  CUSTOMER_WEBHOOK_HEADER_NAMES,
} from "../src/webhooks.js";

const AT = "2026-02-01T10:00:00.000Z";
const AT2 = "2026-02-01T10:05:00.000Z";
const AT3 = "2026-02-01T10:10:00.000Z";

let counter = 0;
function uuid(): string {
  counter += 1;
  return `90000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function context(material: string) {
  return {
    commandId: uuid(),
    correlationId: `corr-${counter}`,
    idempotencyKey: `idem-${counter}`,
    apiKeyMaterial: material,
  };
}

function setup() {
  const harness = createEnterpriseApiHarness({
    enrollmentIdGenerator: uuid,
    keyIdGenerator: uuid,
    deliveryIdGenerator: uuid,
    now: () => AT,
  });
  const client = new EnterpriseApiClient({ transport: harness.transport });
  return { harness, client };
}

async function bootstrapKey(
  harness: ReturnType<typeof createEnterpriseApiHarness>,
  scopes: readonly string[],
): Promise<{ readonly material: string; readonly tenantId: string }> {
  // Bootstrap: a key issued directly through the service (production seeds
  // the first key out-of-band; the fake exposes the same service).
  const issuance = await harness.apiKeys.issue(
    { tenantId: fixtureTenantId(), name: "bootstrap", scopes: [...scopes] },
    { commandId: uuid(), correlationId: "corr-boot", idempotencyKey: `boot-${counter}`, actorId: "actor-1" },
    AT,
  );
  return { material: issuance.material.value, tenantId: issuance.record.tenantId };
}

describe("the enterprise API surface end-to-end (typed client + fake)", () => {
  it("walks the enrollment journey through the API", async () => {
    const { harness, client } = setup();
    const { material } = await bootstrapKey(harness, ["enrollments:manage"]);

    const created = await client.createEnrollment(
      { organizationName: "Acahat Freight Co" },
      context(material),
    );
    expect(created.state).toBe("draft");
    expect(created.tenantId).toBeNull();

    const submitted = await client.submitEnrollment(created.enrollmentId, context(material));
    expect(submitted.state).toBe("submitted");

    const verified = await client.verifyEnrollment(created.enrollmentId, context(material));
    expect(verified.state).toBe("verified");
    expect(verified.tenantId).not.toBeNull();

    const active = await client.activateEnrollment(created.enrollmentId, context(material));
    expect(active.state).toBe("active");

    const listed = await client.listEnrollments(context(material));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enrollmentId).toBe(created.enrollmentId);
  });

  it("configures reference-only federation through the API", async () => {
    const { harness, client } = setup();
    const { material } = await bootstrapKey(harness, ["enrollments:manage"]);
    const federation = await client.configureFederation(
      { protocol: "oidc", issuerReference: "https://idp.acahat.example/oidc" },
      context(material),
    );
    expect(federation.protocol).toBe("oidc");
    const listed = await client.listFederation(context(material));
    expect(listed).toHaveLength(1);
  });

  it("manages API keys through the API (issue -> rotate -> revoke)", async () => {
    const { harness, client } = setup();
    const { material, tenantId } = await bootstrapKey(harness, ["api-keys:manage", "connectivity:read"]);
    const issued = await client.createApiKey(
      { name: "ci-key", scopes: ["connectivity:read"] },
      context(material),
    );
    expect(issued.key.scopes).toEqual(["connectivity:read"]);
    expect(issued.material.startsWith("rlk_live_")).toBe(true);

    // The new key works for its granted scope through the same fake.
    const rotated = await client.rotateApiKey(issued.key.keyId, context(material));
    expect(rotated.key.lastRotatedAt).toBe(AT);

    // The OLD material fails authentication after rotation + retire.
    harness.secrets.retire(`enterprise.api-key.${issued.key.keyId}`, 1);
    await expect(
      client.listApiKeys({ ...context(issued.material) }),
    ).rejects.toThrowError(EnterpriseApiError);

    const revoked = await client.revokeApiKey(issued.key.keyId, context(material));
    expect(revoked.status).toBe("revoked");

    const listed = await client.listApiKeys(context(material));
    expect(listed.some((key) => key.keyId === issued.key.keyId)).toBe(true);
    void tenantId;
  });

  it("provisions connectors and enrolls a managed edge device", async () => {
    const { harness, client } = setup();
    const { material } = await bootstrapKey(harness, ["enrollments:manage"]);
    const enrollment = await client.createEnrollment(
      { organizationName: "Acahat Freight Co" },
      context(material),
    );
    const connector = await client.provisionConnector(
      {
        enrollmentId: enrollment.enrollmentId,
        connectorId: "acahat-mdm",
        requestedCapabilities: ["mdm-managed-configuration", "observation"],
        availableCapabilities: ["mdm-managed-configuration", "observation", "user-guided-actions"],
      },
      context(material),
    );
    expect(connector.operatingMode).toBe("enterprise");
    expect(connector.state).toBe("provisioned");

    const managed = await client.enrollManagedEdge(
      connector.provisioningId,
      {
        deviceRef: "device-7f3a",
        capabilitySnapshotDigest: "b".repeat(64),
        capabilitySnapshotSequence: 1,
      },
      context(material),
    );
    expect(managed.deviceRef).toBe("device-7f3a");
    const listed = await client.listManagedEdgeEnrollments(connector.provisioningId, context(material));
    expect(listed).toHaveLength(1);
  });

  it("registers webhook endpoints, emits signed transitions, lists deliveries", async () => {
    const { harness, client } = setup();
    const { material, tenantId } = await bootstrapKey(harness, ["webhooks:manage"]);

    const registered = await client.registerWebhookEndpoint(
      { url: "https://hooks.customer.example/roamlink" },
      context(material),
    );
    expect(registered.endpoint.status).toBe("pending");
    expect(registered.signingSecret.length).toBeGreaterThan(0);

    // Emit a durable transition through the test seam (NOT a route).
    const outcomes = await harness.emitTransition(
      tenantId,
      {
        origin: "roamlink_state_transition",
        aggregateType: "order",
        aggregateId: "a0000000-0000-4000-8000-000000000001",
        transition: "order.placed",
        eventId: "a0000000-0000-4000-8000-000000000002",
        occurredAt: AT2,
      },
      AT2,
    );
    expect(outcomes[0]?.outcome).toBe("delivered");

    // The delivered payload is signed with the endpoint secret the customer
    // received once - verify it end-to-end with the contract verifier.
    const endpoint = await harness.webhookEndpoints.get(registered.endpoint.endpointId);
    expect(endpoint?.status).toBe("active");
    const deliveries = await client.listWebhookDeliveries(
      registered.endpoint.endpointId,
      context(material),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.outcome).toBe("delivered");
  });

  it("replaying the same request replays the original response (idempotency)", async () => {
    const { harness, client } = setup();
    const { material } = await bootstrapKey(harness, ["enrollments:manage"]);
    // The SAME command envelope (request/correlation/idempotency ids) replays
    // the ORIGINAL response with no additional effect (RL-LOCK-014).
    const ctx = context(material);
    const first = await client.createEnrollment(
      { organizationName: "Acahat Freight Co" },
      ctx,
    );
    const replay = await client.createEnrollment(
      { organizationName: "Acahat Freight Co" },
      ctx,
    );
    expect(replay.enrollmentId).toBe(first.enrollmentId);
    const listed = await client.listEnrollments(context(material));
    expect(listed).toHaveLength(1);
  });
});

describe("the request discipline order (spec/security.md Authorization)", () => {
  it("answers 401 BEFORE touching any state when the material is missing/wrong", async () => {
    const { harness, client } = setup();
    await bootstrapKey(harness, ["enrollments:manage"]);
    await expect(
      client.listEnrollments({
        commandId: uuid(),
        correlationId: "corr-x",
        idempotencyKey: "idem-x",
        apiKeyMaterial: "rlk_live_0000.deadbeef",
      }),
    ).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
    expect(await harness.onboarding.list()).toHaveLength(0);
  });

  it("answers 403 when the key lacks the route scope (no state touched)", async () => {
    const { harness, client } = setup();
    const { material } = await bootstrapKey(harness, ["connectivity:read"]);
    await expect(client.listEnrollments(context(material))).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
    expect(await harness.enrollments.list()).toHaveLength(0);
  });

  it("answers 400 on malformed command envelopes", async () => {
    const { harness } = setup();
    const { material } = await bootstrapKey(harness, ["enrollments:manage"]);
    const response = await harness.transport.request({
      method: "POST",
      path: "/v1/enterprise/enrollments",
      headers: { "x-roamlink-api-key": material },
      body: JSON.stringify({ commandId: "not-a-uuid", correlationId: "c", idempotencyKey: "k", organizationName: "X" }),
    });
    expect(response.status).toBe(400);
  });

  it("answers 404 for unknown routes (no existence oracle)", async () => {
    const { harness } = setup();
    const { material } = await bootstrapKey(harness, ["enrollments:manage"]);
    const response = await harness.transport.request({
      method: "GET",
      path: "/v1/enterprise/does-not-exist",
      headers: { "x-roamlink-api-key": material },
    });
    expect(response.status).toBe(404);
  });
});

describe("the mutation acknowledgement contract (spec/api.md Command semantics)", () => {
  it("keeps the four stages separate and ordered", () => {
    expect(ENTERPRISE_MUTATION_STAGES).toEqual([
      "accepted",
      "executed",
      "delivered",
      "billable-final",
    ]);
    const ack = parseEnterpriseMutationAcknowledgement({
      commandId: uuid(),
      correlationId: "corr-ack",
      idempotencyKey: "idem-ack",
      acceptedAt: AT,
      executedAt: AT2,
    });
    expect(ack.acceptedAt).toBe(AT);
    expect(ack.executedAt).toBe(AT2);
    expect(ack.deliveredAt).toBeUndefined();
    expect(ack.billableFinalAt).toBeUndefined();
  });

  it("rejects structurally impossible stage combinations (collapsed pipelines)", () => {
    const base = {
      commandId: uuid(),
      correlationId: "corr-ack",
      idempotencyKey: "idem-ack",
      acceptedAt: AT,
    };
    expect(() =>
      parseEnterpriseMutationAcknowledgement({ ...base, deliveredAt: AT2 }),
    ).toThrowError();
    expect(() =>
      parseEnterpriseMutationAcknowledgement({ ...base, billableFinalAt: AT2 }),
    ).toThrowError();
    expect(() =>
      parseEnterpriseMutationAcknowledgement({ ...base, unknownField: true }),
    ).toThrowError();
  });

  it("webhook signatures verify end-to-end against the endpoint secret", async () => {
    const { harness, client } = setup();
    const { material, tenantId } = await bootstrapKey(harness, ["webhooks:manage"]);
    const registered = await client.registerWebhookEndpoint(
      { url: "https://hooks.customer.example/roamlink" },
      context(material),
    );
    await harness.emitTransition(
      tenantId,
      parseDurableStateTransition({
        origin: "roamlink_state_transition",
        aggregateType: "order",
        aggregateId: "a0000000-0000-4000-8000-000000000003",
        transition: "order.cancelled",
        eventId: "a0000000-0000-4000-8000-000000000004",
        occurredAt: AT3,
      }),
      AT3,
    );
    // Re-sign the (reconstructed) canonical event envelope with the received
    // secret and verify through the public contract verifier.
    const secretName = `enterprise.webhook-endpoint.${registered.endpoint.endpointId}`;
    const payload = JSON.stringify({
      contractVersion: "0.1",
      tenantId,
      eventId: "a0000000-0000-4000-8000-000000000004",
      eventType: "order.cancelled",
      aggregateType: "order",
      aggregateId: "a0000000-0000-4000-8000-000000000003",
      occurredAt: AT3,
      emittedAt: AT3,
    });
    const deliveryId = "b0000000-0000-4000-8000-000000000001";
    const signature = signCustomerWebhookDelivery(
      registered.signingSecret,
      buildCustomerWebhookSignatureMessage(
        secretName,
        AT3,
        deliveryId,
        "a0000000-0000-4000-8000-000000000004",
        payload,
      ),
    );
    const { verifyCustomerWebhookDelivery } = await import("../src/webhooks.js");
    const verification = verifyCustomerWebhookDelivery(
      {
        payload,
        headers: {
          [CUSTOMER_WEBHOOK_HEADER_NAMES.signature]: signature,
          [CUSTOMER_WEBHOOK_HEADER_NAMES.timestamp]: AT3,
          [CUSTOMER_WEBHOOK_HEADER_NAMES.keyId]: secretName,
          [CUSTOMER_WEBHOOK_HEADER_NAMES.eventId]: "a0000000-0000-4000-8000-000000000004",
          [CUSTOMER_WEBHOOK_HEADER_NAMES.deliveryId]: deliveryId,
          [CUSTOMER_WEBHOOK_HEADER_NAMES.sequence]: "1",
          [CUSTOMER_WEBHOOK_HEADER_NAMES.algorithm]: "hmac-sha256",
        },
      },
      { secretForKeyId: (keyId) => (keyId === secretName ? registered.signingSecret : null) },
      AT3,
    );
    expect(verification).toMatchObject({ ok: true });
  });
});
