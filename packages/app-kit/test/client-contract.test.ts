/**
 * API-client contract tests (RL-060/061 verification gate).
 *
 * Proves the typed client honors the public application API contract:
 *  - typed request/response round-trips through the deterministic fake;
 *  - every mutation carries request-id, correlation-id, idempotency-key,
 *    actor and tenant headers (spec/api.md "Command semantics");
 *  - optimistic-version headers reach the wire and conflicts surface as
 *    typed ApiClientError(kind=conflict);
 *  - retrying with the SAME idempotency key replays the original
 *    acknowledgement without duplicating effects (RL-LOCK-014);
 *  - transport failures and contract-violating bodies fail closed as typed
 *    errors (never raw third-party text, RL-LOCK-016);
 *  - the acknowledgement parser rejects collapsed stage combinations.
 */
import { describe, expect, it } from "vitest";

import {
  isApiClientError,
  MUTATION_HEADERS,
  parseMutationAcknowledgement,
  RoamLinkApiClient,
  createInMemoryApi,
  fakeApiSeed,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../src/index.js";
import { DeterministicClock, DeterministicUuidGenerator, SequenceIdGenerator } from "@roamlink/testkit";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const DEVICE_ID = "dddddddd-0000-4000-8000-000000000001";

function buildClient(options?: {
  actor?: string;
  tenant?: string;
  transport?: HttpTransport;
  captured?: HttpRequest[];
}) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const ids = new DeterministicUuidGenerator(9000);
  const fake = createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => ids.next(),
  });
  const transport: HttpTransport =
    options?.transport ??
    (options?.captured === undefined
      ? fake.transport
      : {
          async request(request: HttpRequest): Promise<HttpResponse> {
            options.captured?.push(request);
            return fake.transport.request(request);
          },
        });
  const client = new RoamLinkApiClient({
    transport,
    actor: {
      actorId: options?.actor ?? MEMBER_ACTOR,
      tenantId: options?.tenant ?? TENANT,
    },
    ids: new SequenceIdGenerator({ prefix: "client-" }),
  });
  return { client, fake, clock };
}

describe("typed reads over the deterministic fake", () => {
  it("returns parsed device resources with evaluated freshness", async () => {
    const { client } = buildClient();
    const devices = await client.listDevices();
    expect(devices).toHaveLength(2);
    const phone = devices.find((d) => d.deviceId === DEVICE_ID);
    expect(phone?.name).toBe("Phone");
    expect(phone?.capabilityFreshness?.freshnessState).toBe("FRESH");
    const laptop = devices.find((d) => d.name === "Laptop");
    expect(laptop?.capabilityFreshness?.freshnessState).toBe("STALE");
    expect(laptop?.contextFreshness).toBeNull();
  });

  it("parses the connectivity overview without any combined status", async () => {
    const { client } = buildClient();
    const overview = await client.getConnectivityOverview();
    expect(overview.presentedAt).toBe("2025-01-06T09:45:00.000Z");
    const subjects = overview.subjects.map((s) => s.subjectType).sort();
    expect(subjects).toEqual(["order", "subscription"]);
    for (const subject of overview.subjects) {
      expect(Object.keys(subject)).not.toContain("status");
      expect(Object.keys(subject)).not.toContain("connectivityStatus");
    }
  });

  it("parses actor session with the role-based permission set", async () => {
    const { client } = buildClient();
    const session = await client.getActorSession();
    expect(session.role).toBe("member");
    expect(session.permissions).toContain("org:read");
    expect(session.permissions).not.toContain("org:manage");
  });
});

describe("mutation envelope on the wire (RL-LOCK-014)", () => {
  it("every mutation carries the full command header set", async () => {
    const captured: HttpRequest[] = [];
    const { client } = buildClient({ captured });
    await client.enrollDevice({ name: "Tablet", platform: "android" });
    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers[MUTATION_HEADERS.requestId]).toMatch(/^client-/);
    expect(request?.headers[MUTATION_HEADERS.correlationId]).toMatch(/^client-/);
    expect(request?.headers[MUTATION_HEADERS.idempotencyKey]).toMatch(/^client-/);
    expect(request?.headers[MUTATION_HEADERS.actorId]).toBe(MEMBER_ACTOR);
    expect(request?.headers[MUTATION_HEADERS.tenantId]).toBe(TENANT);
    expect(request?.path).toBe("/v1/devices");
  });

  it("reusing an idempotency key replays the original acknowledgement", async () => {
    const { client, fake } = buildClient();
    const first = await client.enrollDevice(
      { name: "Tablet", platform: "android" },
      { idempotencyKey: "idem-tablet" },
    );
    const replay = await client.enrollDevice(
      { name: "Tablet", platform: "android" },
      { idempotencyKey: "idem-tablet" },
    );
    expect(replay.commandId).toBe(first.commandId);
    const devices = await client.listDevices();
    expect(devices.filter((d) => d.name === "Tablet")).toHaveLength(1);
    expect(fake.controls.commands().filter((c) => c.idempotencyKey === "idem-tablet")).toHaveLength(1);
  });

  it("different idempotency keys are different commands", async () => {
    const { client } = buildClient();
    const first = await client.enrollDevice(
      { name: "Tablet", platform: "android" },
      { idempotencyKey: "idem-a" },
    );
    const second = await client.enrollDevice(
      { name: "Tablet", platform: "android" },
      { idempotencyKey: "idem-b" },
    );
    expect(second.commandId).not.toBe(first.commandId);
    const devices = await client.listDevices();
    expect(devices.filter((d) => d.name === "Tablet")).toHaveLength(2);
  });

  it("pins the optimistic version header when provided", async () => {
    const captured: HttpRequest[] = [];
    const { client } = buildClient({ captured });
    const device = (await client.listDevices()).find((d) => d.deviceId === DEVICE_ID);
    expect(device).toBeDefined();
    const revision = device?.revision;
    if (revision === undefined) throw new Error("missing device revision");
    await client.updateDevice(
      { deviceId: DEVICE_ID, name: "Phone Pro" },
      { expectedVersion: revision },
    );
    const request = captured.find((r) => r.method === "POST");
    expect(request?.headers[MUTATION_HEADERS.expectedVersion]).toBe("1");
    const updated = (await client.listDevices()).find((d) => d.deviceId === DEVICE_ID);
    expect(updated?.name).toBe("Phone Pro");
    expect(updated?.revision).toBe(2);
  });
});

describe("typed failures (fail closed)", () => {
  it("optimistic-version conflicts surface as ApiClientError(conflict)", async () => {
    const { client } = buildClient();
    const error = await client
      .updateDevice({ deviceId: DEVICE_ID, name: "X" }, { expectedVersion: 99 })
      .catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.kind).toBe("conflict");
      expect(error.reason).toBe("OPTIMISTIC_VERSION_CONFLICT");
      expect(error.retryable).toBe(false);
      expect(error.status).toBe(409);
    }
  });

  it("missing optimistic version is a typed validation failure", async () => {
    const { client } = buildClient();
    const error = await client
      .updateDevice({ deviceId: DEVICE_ID, name: "X" })
      .catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.kind).toBe("validation");
      expect(error.reason).toBe("OPTIMISTIC_VERSION_REQUIRED");
    }
  });

  it("cross-tenant reads are 404 with no existence oracle", async () => {
    const { client } = buildClient({
      tenant: "org:99999999-8888-4777-8666-555555555555",
    });
    const error = await client.listDevices().catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.kind).toBe("not-found");
      expect(error.status).toBe(404);
    }
  });

  it("transport failures fail closed as retryable unavailable", async () => {
    const { client } = buildClient({
      transport: {
        async request(): Promise<HttpResponse> {
          throw new Error("ECONNREFUSED http://secret-host:5432");
        },
      },
    });
    const error = await client.listDevices().catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.kind).toBe("unavailable");
      expect(error.retryable).toBe(true);
      expect(error.message).not.toContain("secret-host");
    }
  });

  it("contract-violating success bodies fail closed as unknown-state", async () => {
    const { client } = buildClient({
      transport: {
        async request(): Promise<HttpResponse> {
          return { status: 200, body: JSON.stringify({ totally: "unrelated" }) };
        },
      },
    });
    const error = await client.listDevices().catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.kind).toBe("unknown-state");
      expect(error.reason).toBe("RESPONSE_CONTRACT_VIOLATION");
    }
  });

  it("contract-violating error bodies fail closed without third-party text", async () => {
    const { client } = buildClient({
      transport: {
        async request(): Promise<HttpResponse> {
          return {
            status: 500,
            body: JSON.stringify({ html: "<script>", password: "hunter2" }),
          };
        },
      },
    });
    const error = await client.listDevices().catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.kind).toBe("unknown-state");
      expect(error.reason).toBe("ERROR_BODY_UNPARSEABLE");
      expect(error.message).not.toContain("hunter2");
    }
  });
});

describe("mutation acknowledgement parsing (stage separation)", () => {
  const base = {
    commandId: "00000000-0000-4000-8000-000000000001",
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    acceptedAt: "2025-01-06T09:00:00.000Z",
  };

  it("parses an accepted+executed acknowledgement", () => {
    const ack = parseMutationAcknowledgement({
      ...base,
      executedAt: "2025-01-06T09:00:01.000Z",
    });
    expect(ack.acceptedAt).toBe("2025-01-06T09:00:00.000Z");
    expect(ack.executedAt).toBe("2025-01-06T09:00:01.000Z");
    expect(ack.deliveredAt).toBeUndefined();
    expect(ack.billableFinalAt).toBeUndefined();
  });

  it("rejects delivered without executed (collapsed stages)", () => {
    expect(() =>
      parseMutationAcknowledgement({
        ...base,
        deliveredAt: "2025-01-06T09:00:02.000Z",
      }),
    ).toThrowError(/deliveredAt/);
  });

  it("rejects billable-final without delivered", () => {
    expect(() =>
      parseMutationAcknowledgement({
        ...base,
        executedAt: "2025-01-06T09:00:01.000Z",
        billableFinalAt: "2025-01-06T09:00:03.000Z",
      }),
    ).toThrowError(/billableFinalAt/);
  });

  it("rejects unknown fields and missing acceptedAt", () => {
    expect(() =>
      parseMutationAcknowledgement({ ...base, status: "delivered" }),
    ).toThrowError(/unknown field/);
    const { acceptedAt: _drop, ...noAccepted } = base;
    expect(() => parseMutationAcknowledgement(noAccepted)).toThrowError(/acceptedAt/);
  });
});

describe("command status polling (stage progression)", () => {
  it("progresses delivered only when evidence arrives", async () => {
    const { client, fake } = buildClient();
    const ack = await client.placeOrder(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "idem-order" },
    );
    expect(ack.executedAt).toBeDefined();
    expect(ack.deliveredAt).toBeUndefined();

    fake.controls.linkDeliveryEvidence({
      subjectType: "order",
      subjectId: ack.resource?.id ?? "",
      evidenceClass: "AUTHENTICATED_WEBHOOK",
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "ctr_new",
      sourceVersion: 1,
      eventId: "evt_new",
      payloadDigest: "d".repeat(64),
      freshUntil: "2025-01-06T12:00:00.000Z",
    });
    const progressed = await client.getCommandStatus(ack.commandId);
    expect(progressed.deliveredAt).toBeDefined();
    expect(progressed.billableFinalAt).toBeUndefined();
  });
});
