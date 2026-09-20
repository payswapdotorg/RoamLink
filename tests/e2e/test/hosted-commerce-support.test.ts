/**
 * RL-113 — the hosted user-journey E2E suite, part 3:
 * activity explanation, purchase, delivery and support over the REAL
 * hosted composition.
 *
 * The commerce journey's frozen law is pinned END TO END here: the real
 * runtime accepts the purchase and payment commands durably (202, ledger +
 * outbox), the delivery-progress view honestly refuses its reads instead of
 * rendering a payment-success page, and the four-stage command pipeline is
 * readable from the durable stored-command view with ONLY the accepted
 * stage reached — payment success never collapses into delivery (RL-LOCK-008).
 */
import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "@roamlink/persistence-postgres";

import { bootHostedJourney } from "../src/host.js";

const VARIANT_ID = "05050505-0000-4000-8000-000000000005";

describe("RL-113 hosted journey: activity explanation", () => {
  it("keeps the activity narrative fail-closed while the read-marking command stays durable", async () => {
    const journey = await bootHostedJourney({ seed: 0x0c1, email: "activity@example.com" });
    try {
      const activityPage = await journey.app.renderDocument({ page: "activity" });
      expect(activityPage).toContain('data-error-kind="unavailable"');
      expect(activityPage).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      // The activity destination is discoverable from the persistent shell.
      expect(activityPage).toContain('href="/activity"');

      // The read-marking command is accepted durably (the notification read
      // model itself is not composed, so the flow's target id is the
      // customer's own deterministic reference — accepted != executed).
      const notificationId = "06060606-0000-4000-8000-000000000006";
      const marked = await journey.app.markNotificationReadFlow(
        { notificationId },
        { idempotencyKey: "e2e-activity-read" },
      );
      expect(marked.status).toBe("ok");
      if (marked.status !== "ok") return;
      expect(marked.acknowledgement.acceptedAt).toBeDefined();
      expect(marked.acknowledgement.executedAt).toBeUndefined();
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.outbox.count("PENDING")).toBe(1);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: purchase", () => {
  it("accepts the order + payment commands durably and refuses to render a payment-success delivery page", async () => {
    const journey = await bootHostedJourney({ seed: 0x0c2, email: "purchase@example.com" });
    try {
      // Entry point + discoverability: the Plans & Billing destination.
      const commercePage = await journey.app.renderDocument({ page: "commerce" });
      expect(commercePage).toContain('data-error-kind="unavailable"');
      expect(commercePage).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(commercePage).toContain('href="/commerce"');

      // Primary task completion: both commerce commands are durably
      // accepted through the real boundary.
      const placed = await journey.app.placeOrderFlow(
        { lines: [{ variantId: VARIANT_ID, quantity: 1 }] },
        { idempotencyKey: "e2e-purchase-order" },
      );
      expect(placed.status).toBe("ok");
      if (placed.status !== "ok") return;
      const paid = await journey.app.recordPaymentFlow(
        { orderId: "07070707-0000-4000-8000-000000000007", amountMinor: 2499, currency: "USD" },
        { idempotencyKey: "e2e-purchase-payment" },
      );
      expect(paid.status).toBe("ok");
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(2);
      expect(await persistence.outbox.count("PENDING")).toBe(2);

      // THE DELIVERY-PROGRESS LAW: the order journey page (the route the
      // customer lands on after paying) fails closed on its reads — it
      // NEVER renders payment success as connectivity delivery.
      const orderPage = await journey.app.renderDocument({
        page: "order",
        params: {
          orderId: "07070707-0000-4000-8000-000000000007",
          commandId: placed.acknowledgement.commandId,
        },
      });
      expect(orderPage).toContain('data-error-kind="unavailable"');
      expect(orderPage).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(orderPage).not.toContain('data-commerce-chain="true"');
      expect(orderPage).not.toContain('data-connectivity-chain="true"');
      expect(orderPage).not.toContain("Payment confirmed?");
      expect(orderPage).not.toContain('data-chain-stage="connectivity-requested"');
      // The command pipeline is never fabricated onto the page either: the
      // failed read fails the whole body closed (no partial pages).
      expect(orderPage).not.toContain('data-stage="accepted"');

      // Recovery state: same-key order replay is the SAME acknowledgement.
      const replay = await journey.app.placeOrderFlow(
        { lines: [{ variantId: VARIANT_ID, quantity: 1 }] },
        { idempotencyKey: "e2e-purchase-order" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement).toEqual(placed.acknowledgement);
      expect(await persistence.records("api-commands").count()).toBe(2);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: delivery", () => {
  it("exposes the durable four-stage pipeline with only the accepted stage reached", async () => {
    const journey = await bootHostedJourney({ seed: 0x0c3, email: "delivery@example.com" });
    try {
      const placed = await journey.app.placeOrderFlow(
        { lines: [{ variantId: VARIANT_ID, quantity: 2 }] },
        { idempotencyKey: "e2e-delivery-order" },
      );
      expect(placed.status).toBe("ok");
      if (placed.status !== "ok") return;
      const commandId = placed.acknowledgement.commandId;

      // The delivery journey over the real runtime IS the command-status
      // read: durable, tenant-scoped, and honest about its stages —
      // accepted only; executed/delivered/billable-final await the worker
      // plane and are NEVER claimed by the boundary.
      const stored = await journey.app.client().getCommandStatus(commandId);
      expect(stored.commandId).toBe(commandId);
      expect(stored.idempotencyKey).toBe("e2e-delivery-order");
      expect(stored.acceptedAt).toBe(placed.acknowledgement.acceptedAt);
      expect(stored.executedAt).toBeUndefined();
      expect(stored.deliveredAt).toBeUndefined();
      expect(stored.billableFinalAt).toBeUndefined();

      // The raw stored-command record keeps the full four-stage timeline in
      // the real SQL ledger (all later stages null — never guessed).
      const raw = await journey.v1({
        method: "GET",
        path: `/v1/commands/${commandId}`,
        headers: {
          "x-roamlink-actor-id": journey.identity.actorId,
          "x-roamlink-tenant-id": journey.identity.tenantId,
        },
      });
      expect(raw.status).toBe(200);
      const command = JSON.parse(raw.body ?? "{}") as Record<string, unknown>;
      expect(command["executedAt"]).toBeUndefined();
      expect(command["deliveredAt"]).toBeUndefined();
      expect(command["billableFinalAt"]).toBeUndefined();
      expect(command["resource"]).toBeUndefined();

      // A foreign command id is an honest 404 (no existence oracle).
      const missing = await journey.v1({
        method: "GET",
        path: "/v1/commands/08080808-0000-4000-8000-000000000008",
        headers: {
          "x-roamlink-actor-id": journey.identity.actorId,
          "x-roamlink-tenant-id": journey.identity.tenantId,
        },
      });
      expect(missing.status).toBe(404);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: support", () => {
  it("files the correlated support case durably while the case list stays honestly uncomposed", async () => {
    const journey = await bootHostedJourney({ seed: 0x0c4, email: "support@example.com" });
    try {
      // Entry point: the Support destination renders fail-closed (the case
      // read model is not composed) but stays discoverable everywhere.
      const supportPage = await journey.app.renderDocument({ page: "support" });
      expect(supportPage).toContain('data-error-kind="unavailable"');
      expect(supportPage).toContain('data-error-reason="READ_MODEL_NOT_COMPOSED"');
      expect(supportPage).toContain(">Support</a>");

      // The escape hatch's ACTION completes: the case command (with typed
      // related references riding along for triage) is durably accepted.
      const opened = await journey.app.createSupportCaseFlow(
        {
          subject: "My connectivity has no delivery evidence yet",
          description: "I paid but the delivery progress view cannot confirm anything yet.",
          priority: "high",
          relatedRefs: [
            { kind: "order", id: "07070707-0000-4000-8000-000000000007" },
            { kind: "device", id: "0d0d0d0d-0000-4000-8000-000000000004" },
          ],
        },
        { idempotencyKey: "e2e-support-case" },
      );
      expect(opened.status).toBe("ok");
      if (opened.status !== "ok") return;
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(1);

      // Recovery: same-key replay re-serves the same acknowledgement.
      const replay = await journey.app.createSupportCaseFlow(
        {
          subject: "My connectivity has no delivery evidence yet",
          description: "I paid but the delivery progress view cannot confirm anything yet.",
          priority: "high",
          relatedRefs: [
            { kind: "order", id: "07070707-0000-4000-8000-000000000007" },
            { kind: "device", id: "0d0d0d0d-0000-4000-8000-000000000004" },
          ],
        },
        { idempotencyKey: "e2e-support-case" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement).toEqual(opened.acknowledgement);
      expect(await persistence.records("api-commands").count()).toBe(1);
    } finally {
      await journey.dispose();
    }
  });
});
