/**
 * RL-071 scenario: PARTIAL FAILURE - UnitOfWork atomicity + outbox retry.
 *
 * A crash or conflict in the middle of a multi-write unit of work must
 * leave NOTHING applied (atomicity), and the transactional outbox must
 * eventually deliver the business effect after bounded retries
 * (no lost work, no orphan outbox rows, exactly-once effects).
 *
 * The architectural invariants:
 *  - atomic multi-repository commits (business write + outbox enqueue are
 *    ONE unit - the dual-write bug cannot be expressed);
 *  - a failed commit (optimistic-concurrency race) discards EVERYTHING -
 *    neither the business write nor the outbox row is visible;
 *  - the outbox delivery loop retries with backoff and converges
 *    exactly-once (the idempotency key is the effect identity);
 *  - commerce multi-aggregate writes (order + lines + events) commit
 *    atomically or not at all.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryPersistence, type UnitOfWork } from "@roamlink/persistence";
import { ConflictError } from "@roamlink/contracts";
import {
  ORDER_ID,
  PRODUCT_ID,
  T0,
  VARIANT_ID,
  makeSimulation,
} from "../src/harness.js";

const REPO_A = "sim-repo-a";

describe("RL-071 partial failure: UnitOfWork atomicity + outbox retry", () => {
  it("business write + outbox enqueue commit atomically; a failed CAS discards BOTH", async () => {
    const persistence = createInMemoryPersistence();

    // A winning unit of work lands both the record and the outbox row.
    const winner = await persistence.begin();
    await winner.records(REPO_A).insert("entity-1", { value: "business-write" });
    await winner.outbox.enqueue({ idempotencyKey: "idem-1", payload: { effect: "one" }, createdAt: T0 });
    await winner.commit();

    expect(await persistence.records(REPO_A).get("entity-1")).not.toBeNull();
    expect(await persistence.outbox.get("idem-1")).not.toBeNull();

    // A racing unit of work builds the same shape, but its precondition
    // (entity-1 does not exist yet) no longer holds against the COMMITTED
    // state - the insert fails with a typed ConflictError:
    const loser = await persistence.begin();
    let conflict: unknown = null;
    try {
      await loser.records(REPO_A).insert("entity-2", { value: "second-write" });
      await loser.outbox.enqueue({ idempotencyKey: "idem-2", payload: { effect: "two" }, createdAt: T0 });
      await loser.records(REPO_A).insert("entity-1", { value: "conflicting-write" });
      await loser.commit();
    } catch (error) {
      conflict = error;
      await loser.rollback();
    }
    expect(conflict).toBeInstanceOf(ConflictError);

    // NOTHING from the losing unit survived: no second entity, no orphan
    // outbox row (the classic dual-write bug cannot be expressed).
    expect(await persistence.records(REPO_A).get("entity-2")).toBeNull();
    expect(await persistence.outbox.get("idem-2")).toBeNull();
    const storedEntity1 = await persistence.records(REPO_A).get("entity-1");
    expect((storedEntity1?.value as { value: string }).value).toBe("business-write");
  });

  it("the outbox delivery loop: bounded retries with backoff, exactly-once effect", async () => {
    const persistence = createInMemoryPersistence();
    const unitOfWork = await persistence.begin();
    await unitOfWork.outbox.enqueue({
      idempotencyKey: "idem-outbox-retry",
      payload: { effect: "notify" },
      createdAt: T0,
    });
    await unitOfWork.commit();

    // The delivery loop with a transport that fails twice, then accepts.
    const effects: string[] = [];
    let attempts = 0;
    const transport = async (payload: string): Promise<"accepted" | "failed"> => {
      attempts += 1;
      if (attempts <= 2) return "failed";
      effects.push(payload);
      return "accepted";
    };

    // One delivery round: claim due records transactionally, attempt, then
    // mark the outcome in a fresh unit of work (the production shape).
    const deliverRound = async (at: string): Promise<number> => {
      const claimUnit: UnitOfWork = await persistence.begin();
      const claimed = await claimUnit.outbox.claimDue(at, 10);
      await claimUnit.commit();
      if (claimed.length === 0) return 0;
      const outcomeUnit: UnitOfWork = await persistence.begin();
      for (const record of claimed) {
        const payload = new TextDecoder().decode(record.payloadBytes);
        const outcome = await transport(payload);
        if (outcome === "accepted") {
          await outcomeUnit.outbox.markDelivered(record.idempotencyKey, at);
        } else {
          await outcomeUnit.outbox.markAttemptFailed(record.idempotencyKey, at);
        }
      }
      await outcomeUnit.commit();
      return claimed.length;
    };

    // Round 1 (due at creation): fails -> retried later with backoff.
    expect(await deliverRound(T0)).toBe(1);
    expect((await persistence.outbox.get("idem-outbox-retry"))?.deliveryState).toBe("PENDING");
    expect((await persistence.outbox.get("idem-outbox-retry"))?.retryCount).toBe(1);

    // The retry is scheduled 1s out (the default backoff head).
    expect(await deliverRound("2026-01-15T08:30:00.500Z")).toBe(0); // not due yet
    expect(await deliverRound("2026-01-15T08:30:02.000Z")).toBe(1); // due: fails again
    expect((await persistence.outbox.get("idem-outbox-retry"))?.retryCount).toBe(2);

    // Round 3: the transport accepts - DELIVERED, terminal.
    expect(await deliverRound("2026-01-15T08:30:14.000Z")).toBe(1);
    const delivered = await persistence.outbox.get("idem-outbox-retry");
    expect(delivered?.deliveryState).toBe("DELIVERED");
    expect(delivered?.retryCount).toBe(2);
    expect(effects).toEqual(['{"effect":"notify"}']); // exactly once

    // Nothing is claimable anymore (terminal state).
    expect(await deliverRound("2026-01-15T09:00:00.000Z")).toBe(0);
  });

  it("commerce: a mid-order failure leaves NO partial order (atomic multi-aggregate commit)", async () => {
    const simulation = makeSimulation();

    // A product + variant exist; the order pipeline is built.
    await simulation.commerce.catalog.createProduct(simulation.envelope(), {
      productId: PRODUCT_ID,
      name: "Traveler Pass",
    });
    await simulation.commerce.catalog.activateProduct(simulation.envelope(), {
      productId: PRODUCT_ID,
      expectedRevision: 1,
    });
    await simulation.commerce.catalog.createVariant(simulation.envelope(), {
      variantId: VARIANT_ID,
      productId: PRODUCT_ID,
      name: "7-Day",
      sku: "pass-7d",
      billingModel: "one_time",
      termDays: 7,
      price: { amountMinorUnits: 999, currency: "USD" },
    });
    await simulation.commerce.orders.createOrder(simulation.envelope({ orderVersion: 1 }), {
      orderId: ORDER_ID,
      ownerUserId: "00000000-0000-4000-8000-000000000002",
    });

    // The order is placed (valid). Then a PLACEMENT that violates the
    // aggregate rules (double placement) fails cleanly:
    await simulation.commerce.orders.addOrderLine(simulation.envelope({ orderVersion: 1 }), {
      orderId: ORDER_ID,
      lineId: simulation.ids.next(),
      variantId: VARIANT_ID,
      quantity: 1,
    });
    await simulation.commerce.orders.placeOrder(simulation.envelope({ orderVersion: 2 }), {
      orderId: ORDER_ID,
    });

    // The second placement attempt (a duplicate command with a NEW key)
    // fails on the state machine - and leaves NO side effects.
    await expect(
      simulation.commerce.orders.placeOrder(simulation.envelope({ orderVersion: 3 }), {
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/ORDER_TRANSITION_INVALID|ORDER_INVALID/) });

    const order = await simulation.commerce.store.read.orders.findById(
      "usr:00000000-0000-4000-8000-000000000002" as never,
      ORDER_ID as never,
    );
    expect(order?.status).toBe("placed");
    expect(order?.revision).toBe(3); // created + line + placed: exactly the applied history

    // The order's event chain is intact and carries no phantom event.
    const events = await simulation.commerce.store.read.events.listForAggregate(
      "usr:00000000-0000-4000-8000-000000000002" as never,
      "order",
      ORDER_ID,
    );
    expect(events.length).toBe(3);
    expect(events.map((event) => event.transition)).toEqual([
      "order.created",
      "order.line_added",
      "order.placed",
    ]);
  });
});
