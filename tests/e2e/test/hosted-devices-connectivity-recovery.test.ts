/**
 * RL-113 — the hosted user-journey E2E suite, part 2:
 * device enrollment, connectivity observation, degraded connectivity and
 * automatic recovery over the REAL hosted composition.
 *
 * The connectivity journey's honest law end to end: the lifecycle
 * vocabulary (observed -> requested -> accepted -> reserved -> path active
 * -> delivery -> recovered) renders ONLY from what the read model asserts.
 * With the PA-019 composition the connectivity read serves the runtime's
 * REAL state: no command has executed, so no subjects and no device
 * observations exist — the honest no-reference indicator, no stage
 * (including a fabricated "recovered") ever claimed, and an admitted
 * webhook STILL creates no projection (admission is not truth,
 * RL-LOCK-009). The recovery that DOES exist on this runtime is real and
 * asserted: idempotent command replay, the durable stored-command view,
 * and replay-safe webhook admission.
 */
import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "@roamlink/persistence-postgres";
import { isApiClientError } from "@roamlink/app-kit";

import {
  bootHostedJourney,
  createJourneyClock,
  signedWebhookRequest,
} from "../src/host.js";

describe("RL-113 hosted journey: device enrollment", () => {
  it("enrolls durably, then fails the versioned device commands on the honest not-found (never blind)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b1, email: "devices@example.com" });
    try {
      // The Devices destination now renders from the COMPOSED device read
      // (PA-019): the real empty registry (accepted is not executed) with
      // the first-device call to action and the enrollment form.
      const devicesPage = await journey.app.renderDocument({ page: "devices" });
      expect(devicesPage).toContain('data-shell-connectivity="no-reference"');
      expect(devicesPage).toContain('data-devices-empty="true"');
      expect(devicesPage).toContain("No devices yet.");
      expect(devicesPage).toContain("Add your first device");
      expect(devicesPage).toContain('data-flow="enroll-device"');

      // Primary task completion: the enrollment command is durable.
      const enrolled = await journey.app.enrollDeviceFlow(
        { name: "Travel Router", platform: "linux" },
        { idempotencyKey: "e2e-device-enroll" },
      );
      expect(enrolled.status).toBe("ok");
      if (enrolled.status !== "ok") return;
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.records("api-commands").count()).toBe(1);

      // The device-detail read now composes and answers the honest 404 for
      // the unknown device (the enrolled command is accepted, not executed —
      // no device exists yet, and none is invented)...
      const deviceId = "0d0d0d0d-0000-4000-8000-000000000004";
      let deviceRead: unknown;
      try {
        await journey.app.client().getDevice(deviceId);
      } catch (caught) {
        deviceRead = caught;
      }
      expect(isApiClientError(deviceRead)).toBe(true);
      if (isApiClientError(deviceRead)) {
        expect(deviceRead.status).toBe(404);
        expect(deviceRead.kind).toBe("not-found");
        expect(deviceRead.reason).toBe("NOT_FOUND");
      }
      // ...so the detail PAGE fails closed (its read set also includes the
      // notification read model, which honestly keeps its typed 501): an
      // error panel, and NO invented device content either way.
      const detail = await journey.app.renderDocument({
        page: "device",
        params: { deviceId },
      });
      expect(detail).toContain('data-mutation-result="error"');
      expect(detail).not.toContain('data-device-capability="true"');
      expect(detail).not.toContain('data-device-manage="true"');
      // ...and the versioned update/retire flows refuse to command blind:
      // the read-first discipline fails closed on the typed not-found.
      const updated = await journey.app.updateDeviceFlow(
        { deviceId, name: "Travel Router (renamed)" },
        { idempotencyKey: "e2e-device-update" },
      );
      expect(updated.status).toBe("error");
      if (updated.status !== "error") return;
      expect(updated.error).toMatchObject({ kind: "not-found", reason: "NOT_FOUND" });
      const retired = await journey.app.retireDeviceFlow(
        { deviceId },
        { idempotencyKey: "e2e-device-retire" },
      );
      expect(retired.status).toBe("error");
      expect(await persistence.records("api-commands").count()).toBe(1);

      // Recovery state: same-key replay of the enrollment returns the SAME
      // acknowledgement and stores nothing new.
      const replay = await journey.app.enrollDeviceFlow(
        { name: "Travel Router", platform: "linux" },
        { idempotencyKey: "e2e-device-enroll" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement).toEqual(enrolled.acknowledgement);
      expect(await persistence.records("api-commands").count()).toBe(1);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: connectivity observation", () => {
  it("composes the honest real overview: no subjects, no observations, the no-reference indicator", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b2, email: "connectivity@example.com" });
    try {
      const html = await journey.app.renderDocument({ page: "connectivity" });
      // The persistent indicator: the composed overview read serves the real
      // empty aggregate, so the shell states the honest no-reference state
      // (a real claim of nothing — not success, not failure, not a shrug).
      expect(html).toContain('data-shell-connectivity="no-reference"');
      expect(html).toContain("No active connectivity reference");
      expect(html).toContain("nothing is currently set up to deliver connectivity");
      // PA-020: the page body degrades COMPONENT-SCOPED. The core
      // connectivity read composes (the real empty aggregate), so the
      // center renders its honest no-reference content - status, journey,
      // observations; the notification read honestly keeps its typed 501
      // (no notification store is bound on this runtime), so ONLY the
      // recent-events section degrades to the quiet unavailable panel.
      expect(html).toContain('data-connectivity-status="true"');
      expect(html).toContain('data-connection-journey="true"');
      expect(html).toContain('data-device-observations="true"');
      expect(html).toContain('data-unavailable="true"');
      expect(html).toContain('data-unavailable-section="recent-connectivity-events"');
      expect(html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
      expect(html).toContain("NOTIFICATION_STORE_NOT_BOUND");
      // The degraded body is NOT the fail-closed panel.
      expect(html).not.toContain('data-error-kind=');
      expect(html).not.toContain('data-connectivity-overview="true"');

      // The typed client now SUCCEEDS on the composed read and surfaces the
      // real aggregate (the app parses and renders it only through the
      // contract's own fail-closed parser).
      const overview = await journey.app.client().getConnectivityOverview();
      expect(overview.subjects).toEqual([]);
      expect(overview.deviceObservations).toEqual([]);
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: degraded connectivity", () => {
  it("never fabricates the journey vocabulary from an unavailable read, and keeps support reachable", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b3, email: "degraded@example.com" });
    try {
      const html = await journey.app.renderDocument({ page: "connectivity" });
      // THE HONEST-STATE LAW over the real composition (PA-020: the core
      // sections render, the recent-events section degrades quietly): no
      // stage of the lifecycle vocabulary is CONFIRMED (nothing is asserted
      // by a read that refused), and "recovered" is never claimed from
      // anywhere; the observations section renders its honest empty state.
      expect(html).not.toContain("Confirmed by the linked delivery evidence");
      expect(html).toContain("No device observations have been recorded yet");
      // The Activity narrative itself does not leak into the connectivity
      // page (the journey's own not-recorded fact may POINT to Activity,
      // but no activity timeline content renders here).
      expect(html).not.toContain('data-activity-feed="true"');
      expect(html).not.toContain('data-activity-needs-you="true"');
      // The degraded section is the quiet panel with the typed reason —
      // never invented event records.
      expect(html).toContain('data-unavailable-section="recent-connectivity-events"');
      expect(html).not.toContain('data-event-id=');
      // Commerce can never leak into the connectivity journey (payment is
      // not delivery, RL-LOCK-008) — trivially true and pinned fail-closed.
      expect(html).not.toContain("Payment confirmed?");
      // The degraded page still exposes the support escape hatch through
      // the persistent navigation (Support is one keyboard stop away).
      expect(html).toContain(">Support</a>");
      expect(html).toContain('href="/support"');
    } finally {
      await journey.dispose();
    }
  });
});

describe("RL-113 hosted journey: automatic recovery", () => {
  it("recovers commands by idempotent replay, by the durable stored-command view, and by replay-safe webhook admission", async () => {
    const journey = await bootHostedJourney({ seed: 0x0b4, email: "recovery@example.com" });
    try {
      // --- (1) Client retry recovery: a mutation lost in transport is
      // retried with the SAME idempotency key; the real ledger replays the
      // original acknowledgement without a second effect.
      const first = await journey.app.enrollDeviceFlow(
        { name: "Recovery Phone", platform: "android" },
        { idempotencyKey: "e2e-recovery-enroll" },
      );
      expect(first.status).toBe("ok");
      if (first.status !== "ok") return;
      const replay = await journey.app.enrollDeviceFlow(
        { name: "Recovery Phone", platform: "android" },
        { idempotencyKey: "e2e-recovery-enroll" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement).toEqual(first.acknowledgement);

      // A DIFFERENT payload under the SAME key is the typed conflict —
      // never a silent overwrite (RL-LOCK-014 at the real boundary).
      const conflict = await journey.app.enrollDeviceFlow(
        { name: "A Different Device", platform: "android" },
        { idempotencyKey: "e2e-recovery-enroll" },
      );
      expect(conflict.status).toBe("error");
      if (conflict.status !== "error") return;
      expect(conflict.error).toMatchObject({ kind: "conflict", reason: "COMMAND_IDEMPOTENCY_CONFLICT" });

      // --- (2) Durable command-status recovery: a crashed client can
      // re-derive its pipeline state from the stored-command view.
      const stored = await journey.app.client().getCommandStatus(first.acknowledgement.commandId);
      expect(stored).toEqual(first.acknowledgement);
      expect(stored.acceptedAt).toBeDefined();
      expect(stored.executedAt).toBeUndefined();

      // --- (3) Webhook admission is replay-safe: the same delivery
      // admitted twice answers ADMITTED then DUPLICATE, and the durable
      // inbox holds ONE admitted row (no double-processing).
      const delivery = signedWebhookRequest({
        eventId: "evt-e2e-recovery-1",
        deliveryId: "del-e2e-recovery-1",
        resourceType: "connectivity_contract",
        resourceId: "res-e2e-recovery-1",
        resourceVersion: 3,
        eventType: "connectivity_contract.state_changed",
      });
      const firstAdmission = await journey.v1({
        method: "POST",
        path: "/v1/webhooks/adcos",
        headers: Object.fromEntries(new Headers(delivery.headers).entries()),
        body: await delivery.text(),
      });
      expect(firstAdmission.status).toBe(202);
      expect(JSON.parse(firstAdmission.body ?? "{}")).toMatchObject({ outcome: "ADMITTED" });
      const secondDelivery = signedWebhookRequest({
        eventId: "evt-e2e-recovery-1",
        deliveryId: "del-e2e-recovery-1",
        resourceType: "connectivity_contract",
        resourceId: "res-e2e-recovery-1",
        resourceVersion: 3,
        eventType: "connectivity_contract.state_changed",
      });
      const secondAdmission = await journey.v1({
        method: "POST",
        path: "/v1/webhooks/adcos",
        headers: Object.fromEntries(new Headers(secondDelivery.headers).entries()),
        body: await secondDelivery.text(),
      });
      expect(secondAdmission.status).toBe(202);
      expect(JSON.parse(secondAdmission.body ?? "{}")).toMatchObject({ outcome: "DUPLICATE" });
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.inbox.count("ADMITTED")).toBe(1);

      // --- (4) Admission is NOT truth (RL-LOCK-009 end to end): after the
      // webhook was admitted, the composed connectivity read still serves
      // the REAL state — the admission created no projection (projection is
      // the worker plane's concern), so no subject, no evidence and no
      // journey state is claimed anywhere.
      const overview = await journey.app.client().getConnectivityOverview();
      expect(overview.subjects).toEqual([]);
      expect(overview.deviceObservations).toEqual([]);
      const html = await journey.app.renderDocument({ page: "connectivity" });
      expect(html).toContain('data-shell-connectivity="no-reference"');
    } finally {
      await journey.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// PA-025 — the live command-execution path: the COMPOSED direction of
// Journey 4 (both directions are pinned: the uncomposed suite above keeps
// the honest pre-execution terrain UNCHANGED; this leg boots the SAME
// hosted composition with the bounded worker-tick endpoint composed and
// drives it with SIGNED deliveries exactly the way the QStash scheduled
// transport would).
// ---------------------------------------------------------------------------

describe("PA-025 hosted journey: devices over the composed execution path (Journey 4)", () => {
  it("enrolls, ticks, and the executed device appears; the versioned update and retire legs complete against the real revisions", async () => {
    const clock = createJourneyClock();
    const journey = await bootHostedJourney({
      seed: 0x0b5,
      email: "devices-executed@example.com",
      composeWorkerTickEndpoint: true,
      now: clock.now,
    });
    try {
      const tick = journey.workerTick;
      if (tick === null) throw new Error("the worker tick endpoint was not composed");

      // The enrollment command is durably accepted; the devices read is
      // honestly empty (accepted is NOT executed).
      const enrolled = await journey.app.enrollDeviceFlow(
        { name: "Executed Router", platform: "linux" },
        { idempotencyKey: "e2e-device-executed-enroll" },
      );
      expect(enrolled.status).toBe("ok");
      if (enrolled.status !== "ok") return;
      expect(await journey.app.client().listDevices()).toEqual([]);

      // ONE SIGNED delivery executes it: the devices page renders the REAL
      // device (the executed resource appears; the empty panel is gone).
      const enrollExecutedAt = clock.advanceMinutes();
      const firstTick = await tick();
      expect(firstTick.status).toBe(200);
      const devicesPage = await journey.app.renderDocument({ page: "devices" });
      expect(devicesPage).not.toContain('data-devices-empty="true"');
      expect(devicesPage).toContain('data-device-status="enrolled"');

      // The executed device's real id comes from the enrollment REPLAY (the
      // acknowledgement now carries the executed stage + the resource).
      const replay = await journey.app.enrollDeviceFlow(
        { name: "Executed Router", platform: "linux" },
        { idempotencyKey: "e2e-device-executed-enroll" },
      );
      expect(replay.status).toBe("ok");
      if (replay.status !== "ok") return;
      expect(replay.acknowledgement.executedAt).toBe(enrollExecutedAt);
      const deviceId = replay.acknowledgement.resource?.id;
      expect(deviceId).toBeDefined();

      // The device detail read now serves the REAL projection (the honest
      // 404 of the uncomposed terrain is closed by EXECUTION, not by
      // invention).
      const device = await journey.app.client().getDevice(deviceId as string);
      expect(device.deviceId).toBe(deviceId);
      expect(device.name).toBe("Executed Router");
      expect(device.status).toBe("enrolled");
      expect(device.revision).toBe(1);

      // The versioned UPDATE leg — the read-first discipline now finds the
      // executed device: revision 1, the versioned command accepted.
      const updated = await journey.app.updateDeviceFlow(
        { deviceId: deviceId as string, name: "Executed Router (renamed)" },
        { idempotencyKey: "e2e-device-executed-update" },
      );
      expect(updated.status).toBe("ok");
      if (updated.status !== "ok") return;

      // ONE SIGNED delivery executes the update: the projection carries the
      // new name at revision 2.
      clock.advanceMinutes();
      await tick();
      const renamed = await journey.app.client().getDevice(deviceId as string);
      expect(renamed.name).toBe("Executed Router (renamed)");
      expect(renamed.revision).toBe(2);

      // The versioned RETIRE leg against the real revision 2, executed by
      // the final SIGNED delivery: the device is RETIRED.
      const retired = await journey.app.retireDeviceFlow(
        { deviceId: deviceId as string },
        { idempotencyKey: "e2e-device-executed-retire" },
      );
      expect(retired.status).toBe("ok");
      if (retired.status !== "ok") return;
      clock.advanceMinutes();
      await tick();
      const retiredDevice = await journey.app.client().getDevice(deviceId as string);
      expect(retiredDevice.status).toBe("retired");
      expect(retiredDevice.revision).toBe(3);

      // The outbox obligations all committed their terminal outcomes (the
      // durable execution facts behind every projection above).
      const persistence = createPostgresPersistence(journey.composition.driver);
      expect(await persistence.outbox.count("DELIVERED")).toBe(3);
      expect(await persistence.outbox.count("PENDING")).toBe(0);
    } finally {
      await journey.dispose();
    }
  });
});
