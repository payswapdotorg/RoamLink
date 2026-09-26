/**
 * PA-025 — THE EXECUTION-FACTS BATTERY: end-to-end over the REAL seams.
 *
 * The full sanctioned chain, nothing faked:
 *
 *   a command ACCEPTED through the API plane (services/api over real
 *   PostgreSQL + the real infra/migrations)
 *     -> the tick endpoint invoked with a SIGNED delivery (the provider's
 *        own renderQStashSignatureHeader — the scheduled transport's shape)
 *       -> ONE bounded tick over the services/workers execution seam
 *          (claim-commit -> executor -> the command-ledger markExecuted CAS
 *          write -> the outbox outcome commit)
 *         -> the command ADVANCES to executed (the durable record carries
 *            executedAt + the resource it created)
 *           -> the read model serves the REAL projection (the EXECUTED-only
 *              law flips the honest empty state to the real resource)
 *         -> the outbox obligation commits its terminal DELIVERED outcome.
 *
 * Plus the mandated negative matrix: the bounded-batch cap (a backlog
 * larger than the cap advances exactly the cap — honest partial progress);
 * the idempotent re-delivery (the same delivery processed twice advances
 * nothing twice — the CAS + terminal-state proofs); and the honest
 * executor-not-composed law (a kind with no composed executor retries with
 * the diagnosable reason, never silently dropped, never faked).
 */
import { describe, expect, it } from "vitest";

import {
  createExecutionWorld,
  mutationHeaders,
  readHeaders,
  signedTickRequest,
  type ExecutionWorld,
} from "./helpers.js";

/** Reads the stored command straight from the durable ledger. */
async function storedCommandOf(world: ExecutionWorld, commandId: string): Promise<Record<string, unknown> | null> {
  const record = await world.persistence.records("api-commands").get(commandId);
  return record === null ? null : (record.value as Record<string, unknown>);
}

/** Accepts one mutation through the REAL API plane; returns the ack. */
async function accept(
  world: ExecutionWorld,
  path: string,
  key: string,
  body: unknown,
  expectedVersion?: number,
): Promise<{ readonly commandId: string; readonly ack: Record<string, unknown> }> {
  const response = await world.service.handle({
    method: "POST",
    path,
    headers: mutationHeaders({
      actorId: world.session.actorId,
      tenantId: world.session.tenantId,
      token: world.session.token,
      key,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    }),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202); // durably accepted
  const ack = JSON.parse(response.body as string) as Record<string, unknown>;
  return { commandId: String(ack["commandId"]), ack };
}

/** Reads one business read through the REAL API plane. */
async function read(world: ExecutionWorld, path: string): Promise<{ status: number; body: string }> {
  const response = await world.service.handle({
    method: "GET",
    path,
    headers: readHeaders({ token: world.session.token, actorId: world.session.actorId, tenantId: world.session.tenantId }),
  });
  return { status: response.status, body: response.body ?? "" };
}

describe("PA-025 the execution facts (accepted -> SIGNED tick -> executed -> the real projection)", () => {
  it("advances a durably accepted device.enroll to executed and flips the device read model to the REAL resource", async () => {
    const world = await createExecutionWorld();
    try {
      // 1. The honest pre-state: accepted is NOT executed.
      const accepted = await accept(world, "/v1/devices", "enroll-battery-1", {
        name: "Acahat Phone",
        platform: "ios",
      });
      expect(accepted.ack["executedAt"]).toBeUndefined();
      expect(accepted.ack["resource"]).toBeUndefined();
      const before = await read(world, "/v1/devices");
      expect(JSON.parse(before.body)).toEqual([]); // the honest empty state

      // 2. The SIGNED delivery drives ONE bounded tick.
      const tick = await world.endpoint.handle(signedTickRequest({}));
      expect(tick.status).toBe(200);
      const summary = JSON.parse(await tick.text()) as Record<string, unknown>;
      const outbox = summary["outbox"] as Record<string, unknown>;
      expect(outbox["claimed"]).toBe(1);
      expect(outbox["executed"]).toBe(1);
      expect(outbox["delivered"]).toBe(1);
      expect(outbox["remainingPending"]).toBe(0);

      // 3. The command ADVANCED to executed (the durable stage truth).
      const stored = await storedCommandOf(world, accepted.commandId);
      expect(stored?.["executedAt"]).toBe("2026-01-15T08:30:00.000Z"); // the tick's clock
      expect(stored?.["deliveredAt"]).toBeNull(); // stages never collapse
      expect(stored?.["billableFinalAt"]).toBeNull();
      const resource = stored?.["resource"] as { type: string; id: string } | null;
      expect(resource?.["type"]).toBe("device");

      // 4. The read model serves the REAL projection (the EXECUTED-only law).
      const after = await read(world, "/v1/devices");
      const devices = JSON.parse(after.body) as Record<string, unknown>[];
      expect(devices).toHaveLength(1);
      expect(devices.at(0)).toMatchObject({
        deviceId: resource?.["id"],
        name: "Acahat Phone",
        platform: "ios",
        status: "enrolled",
        revision: 1,
      });

      // 5. The outbox outcome committed (the terminal delivery state).
      expect(await world.persistence.outbox.count("DELIVERED")).toBe(1);
      expect(await world.persistence.outbox.count("PENDING")).toBe(0);
    } finally {
      await world.dispose();
    }
  });

  it("advances the goal chain: create executes (the resource appears), then the versioned activate executes (the goal is active)", async () => {
    const world = await createExecutionWorld();
    try {
      // The create is durably accepted; the goal read is honestly empty.
      const _created = await accept(world, "/v1/experience-intents", "goal-create-battery", {
        deviceId: "0f0f0f0f-0000-4000-8000-0000000000f1",
        rationale: "Stay connected while traveling",
        accessClasses: ["any_internet"],
      });
      expect(JSON.parse((await read(world, "/v1/experience-intents")).body)).toEqual([]);

      // ONE tick: the create executes, the goal projects.
      expect((JSON.parse(await (await world.endpoint.handle(signedTickRequest({}))).text()) as Record<string, unknown>)["outbox"]).toMatchObject({
        claimed: 1,
        executed: 1,
      });
      const goals = JSON.parse((await read(world, "/v1/experience-intents")).body) as Record<string, unknown>[];
      expect(goals).toHaveLength(1);
      const goal = goals.at(0);
      expect(goal?.["status"]).toBe("draft");
      expect(goal?.["revision"]).toBe(1);

      // The READ-FIRST activation against the real revision (the journey's
      // versioned leg now finds the executed goal).
      const intentId = String(goal?.["intentId"]);
      const intentRead = await read(world, `/v1/experience-intents/${intentId}`);
      const intent = JSON.parse(intentRead.body) as Record<string, unknown>;
      const revision = Number(intent["revision"]);
      const activated = await accept(
        world,
        `/v1/experience-intents/${intentId}/activate`,
        "goal-activate-battery",
        {},
        revision,
      );
      expect(activated.ack["executedAt"]).toBeUndefined(); // accepted, not yet executed

      // ONE more tick: the activation executes, the goal is ACTIVE.
      await world.endpoint.handle(signedTickRequest({}));
      const active = JSON.parse((await read(world, `/v1/experience-intents/${intentId}`)).body) as Record<string, unknown>;
      expect(active["status"]).toBe("active");
      expect(active["revision"]).toBe(2);
      expect(await world.persistence.outbox.count("DELIVERED")).toBe(2);
    } finally {
      await world.dispose();
    }
  });
});

describe("PA-025 the bounded-batch cap (honest partial progress)", () => {
  it("advances EXACTLY the cap per delivery: a backlog of 12 with a cap of 5 drains 5 + 5 + 2 across three deliveries", async () => {
    const world = await createExecutionWorld({ outboxBatchSize: 5 });
    try {
      for (let index = 1; index <= 12; index += 1) {
        await accept(world, "/v1/devices", `enroll-cap-${index}`, {
          name: `Device ${index}`,
          platform: "android",
        });
      }
      expect(await world.persistence.outbox.count("PENDING")).toBe(12);

      const summaryOf = async (): Promise<Record<string, unknown>> => {
        const response = await world.endpoint.handle(signedTickRequest({}));
        expect(response.status).toBe(200);
        return JSON.parse(await response.text()) as Record<string, unknown>;
      };

      const first = (await summaryOf())["outbox"] as Record<string, unknown>;
      expect(first["claimed"]).toBe(5); // exactly the cap
      expect(first["executed"]).toBe(5);
      expect(first["remainingPending"]).toBe(7); // the honest backlog stays

      const second = (await summaryOf())["outbox"] as Record<string, unknown>;
      expect(second["claimed"]).toBe(5);
      expect(second["remainingPending"]).toBe(2);

      const third = (await summaryOf())["outbox"] as Record<string, unknown>;
      expect(third["claimed"]).toBe(2);
      expect(third["remainingPending"]).toBe(0);

      // The read model serves ALL TWELVE real projections.
      const devices = JSON.parse((await read(world, "/v1/devices")).body) as unknown[];
      expect(devices).toHaveLength(12);
    } finally {
      await world.dispose();
    }
  });
});

describe("PA-025 the idempotent re-delivery (the same delivery twice advances nothing twice)", () => {
  it("processes the SAME signed delivery twice: the second tick claims nothing and the first execution's facts stand", async () => {
    const world = await createExecutionWorld();
    try {
      const accepted = await accept(world, "/v1/devices", "enroll-idem-1", {
        name: "Idem Phone",
        platform: "ios",
      });

      // The SAME delivery (the identical byte-exact body and signature
      // header — a transport redelivery) processed twice.
      const first = await world.endpoint.handle(signedTickRequest({}));
      expect(first.status).toBe(200);
      const second = await world.endpoint.handle(signedTickRequest({}));
      expect(second.status).toBe(200);

      const secondSummary = JSON.parse(await second.text()) as Record<string, unknown>;
      expect((secondSummary["outbox"] as Record<string, unknown>)["claimed"]).toBe(0); // nothing left to claim

      // The CAS + terminal-state proofs: executed exactly once, the FIRST
      // execution's instant and resource stand.
      const stored = await storedCommandOf(world, accepted.commandId);
      expect(stored?.["executedAt"]).toBe("2026-01-15T08:30:00.000Z");
      const deviceId = (stored?.["resource"] as { id: string } | null)?.id;
      expect(deviceId).toBeDefined();
      const devices = JSON.parse((await read(world, "/v1/devices")).body) as Record<string, unknown>[];
      expect(devices).toHaveLength(1); // never duplicated
      expect(devices.at(0)?.["deviceId"]).toBe(deviceId);
      expect(await world.persistence.outbox.count("DELIVERED")).toBe(1);
    } finally {
      await world.dispose();
    }
  });
});

describe("PA-025 the honest executor-not-composed law (never silent, never faked)", () => {
  it("retries a kind without a composed executor with the diagnosable reason; the stage truth never lies", async () => {
    const world = await createExecutionWorld();
    try {
      // order.place has no read model and no composed executor on the demo
      // plane: the command is still DURABLY ACCEPTED (the API plane's law)...
      const accepted = await accept(world, "/v1/orders", "order-noexec-1", {
        lines: [{ variantId: "variant-a", quantity: 1 }],
      });
      expect(accepted.ack["executedAt"]).toBeUndefined();

      // ...and the tick's delivery port answers the honest retryable
      // failure with the diagnosable reason (a rolling deploy that adds the
      // executor self-heals; the budget law applies; never a fake success).
      const tick = await world.endpoint.handle(signedTickRequest({}));
      const summary = JSON.parse(await tick.text()) as Record<string, unknown>;
      expect((summary["outbox"] as Record<string, unknown>)["retryableFailures"]).toBe(1);
      expect((summary["outbox"] as Record<string, unknown>)["executed"]).toBe(0);

      const obligation = await world.persistence.outbox.get("order-noexec-1");
      expect(obligation?.deliveryState).toBe("PENDING"); // rescheduled with backoff
      expect(obligation?.lastErrorReason).toBe("COMMAND_EXECUTOR_NOT_COMPOSED");

      // The stage truth never lied: accepted, NOT executed.
      const stored = await storedCommandOf(world, accepted.commandId);
      expect(stored?.["executedAt"]).toBeNull();
    } finally {
      await world.dispose();
    }
  });
});
