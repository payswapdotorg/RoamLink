/**
 * RL-072 dogfood scenario 2: CONNECTIVITY DEGRADATION -> FAILOVER ->
 * RECOVERY.
 *
 * Starting from honestly established connectivity (the scenario-1 journey),
 * the access path degrades on the ADCOS side WITHOUT any event arriving
 * (the worst case: RoamLink's last signal still says active). The scenario
 * proves the architectural truth properties of the recovery loop:
 *
 *   - the DEVICE keeps observing honestly (RL-041): the observation engine
 *     folds the degraded probe into evidence-tagged context snapshots -
 *     "unknown" connectivity is recorded as UNKNOWN-evidenced truth, never
 *     fabricated as "online" (RL-LOCK-011);
 *   - freshness decays FRESH -> STALE monotonically (RL-LOCK-010): while
 *     ADCOS truth is unreachable, the customer's read model shows STALE -
 *     the last honest observation, aged - never a fabricated "all good"
 *     and never a guessed "degraded" (stale-while-degraded);
 *   - desired-state re-planning: the customer revises the ExperienceIntent
 *     (RL-011), the compiler emits a NEW versioned ADCOS command (RL-012),
 *     a failover contract is selected + activated + reserved (RL-032);
 *   - reconciliation REPAIRS the missed signal (RL-035): the canonical
 *     read discovers DEGRADED, the projection is repaired with
 *     AUTHENTICATED evidence and digest-verified payload truth;
 *   - the customer SEES the truth: the reference relinks to the failover
 *     contract (FRESH, EVIDENCED), the old contract's truth stays DEGRADED
 *     in its own projection (history is never rewritten), and the decision
 *     read model degrades -> recovers exactly with the evidence.
 */
import { describe, expect, it } from "vitest";
import { parseAdcosSignatureRef } from "@roamlink/adcos";
import {
  buildExperienceDecision,
} from "@roamlink/domain-experience";
import {
  MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC,
  MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC,
  SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC,
  STALE_UNKNOWN_STATE_DURATION_MS_METRIC,
  PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC,
  evaluateProductSlo,
} from "@roamlink/observability";
import {
  EdgeObservationEngine,
  parseEdgeObservation,
} from "@roamlink/edge";
import type { IntentCommandInput } from "@roamlink/integration";
import { compileExperienceIntent } from "@roamlink/intent-compiler";
import { parseExperienceDecisionId } from "@roamlink/contracts";

import { instantPlusMs, journeyIntentPayload, must, msBetween } from "../src/world.js";
import {
  seedActiveConnectivity,
  makeJourneyWorld,
  type ActiveConnectivity,
} from "../src/journey.js";

/** The journey device snapshots' freshness window (world fixture). */
const SNAPSHOT_WINDOW_MS = 600_000;
/** Advances the clock past BOTH the projection TTL and the snapshot window. */
const AGING_ADVANCE_MS = SNAPSHOT_WINDOW_MS + 5_000;

describe("RL-072 scenario 2: connectivity degradation -> failover -> recovery", () => {
  it("the full recovery loop: honest observations, stale-while-degraded, failover, reconciliation repair", async () => {
    const seeded = await seedActiveConnectivity(makeJourneyWorld("degradation"));
    const { world, customer, deviceId, intentId, referenceId, contractId } = seeded;
    const actor = { actorId: customer.actorId, tenantId: customer.tenantId };

    // The starting truth: FRESH, EVIDENCED, supported.
    let view = await world.references.describeSubject(
      customer.tenantId,
      "order",
      seeded.orderId as never,
    );
    expect(view.deliveryEvidenceState).toBe("EVIDENCED");
    expect(view.evidence?.freshness.freshnessState).toBe("FRESH");

    // ------------------------------------------------------------------
    // 1. ADCOS's canonical state degrades SILENTLY (no event arrives).
    // ------------------------------------------------------------------
    world.fake.silentStateChange(contractId, "DEGRADED");

    // ------------------------------------------------------------------
    // 2. The device keeps observing (RL-041): the degraded path is folded
    //    into evidence-tagged context snapshots. "unknown" is recorded as
    //    honest UNKNOWN-observable truth - never fabricated "online".
    // ------------------------------------------------------------------
    const observationEngine = new EdgeObservationEngine({
      snapshotIdGenerator: () => world.ids.next(),
      snapshotFreshnessMs: 60_000,
    });
    const degradedProbe = parseEdgeObservation({
      observationId: world.ids.next(),
      deviceRef: `dev:${deviceId}`,
      observedAt: world.clock.now(),
      platform: { family: "ios", platformVersion: "18.2" },
      evidence: { kind: "platform-api-probe", source: "TestProbe" },
      subject: { kind: "context-observation", contextField: "connectivity-state", value: "unknown" },
    });
    const folded = observationEngine.applyContextObservation(null, degradedProbe, world.clock.now());
    expect(folded.applied).toHaveLength(1);
    expect(folded.applied[0]?.applied).toBe(true);
    // The snapshot is evidence-tagged and carries the honest value.
    const connectivityState = folded.snapshot.entries["connectivity-state"];
    expect(connectivityState?.value).toBe("unknown");
    expect(connectivityState?.evidenceClass).not.toBe("UNKNOWN");
    // The evidence discipline: a platform probe is OBSERVED class; the
    // engine NEVER lets a caller claim AUTHENTICATED locally.
    expect(connectivityState?.evidenceClass).toBe("OBSERVED");

    // The server-side registry records the synced degraded context (the
    // observation crosses the sync boundary as a minimized snapshot).
    await world.experience.registry.recordContextSnapshot(world.envelope(actor), {
      deviceId,
      ownerUserId: customer.userId,
      observedAt: world.clock.now(),
      freshUntil: instantPlusMs(world.clock.now(), 600_000),
      consent: { fineLocationGranted: false },
      payload: {
        network: { visibleWifiNetworkCount: 0, cellularRadio: "unknown" },
        battery: { levelPercent: 64, charging: false },
      },
    });

    // ------------------------------------------------------------------
    // 3. Freshness decays (RL-LOCK-010): advance past BOTH the projection
    //    TTL and the device-snapshot window. The customer's read model
    //    degrades to STALE - the AGED last honest observation - while ADCOS
    //    truth is unreachable. It NEVER shows a fabricated fresh state and
    //    never guesses DEGRADED from silence.
    // ------------------------------------------------------------------
    world.clock.advanceBy(AGING_ADVANCE_MS);
    view = await world.references.describeSubject(
      customer.tenantId,
      "order",
      seeded.orderId as never,
    );
    expect(view.evidence?.freshness.freshnessState).toBe("STALE");
    // The recorded linkage stays auditable: recorded FRESH, re-evaluated
    // STALE at the query instant (freshness is evaluated, not stored truth).
    expect(view.evidence?.freshness.recordedFreshnessState).toBe("FRESH");
    expect(view.evidence?.freshness.freshnessState).not.toBe("FRESH");
    expect(view.evidence?.freshness.freshnessState).not.toBe("UNKNOWN");
    // §11 "minutes without usable connectivity" window start: usable truth
    // was physically lost when the OLD contract's freshness guarantee
    // expired (freshUntil, 60s after the seeded projection) - the read model
    // honestly showed STALE from that instant on the aged evidence.
    const notUsableSince = must(
      view.evidence?.freshness.freshUntil,
      "guarantee-expiry instant of the degraded evidence",
    );

    // The decision read model degrades with the evidence: STALE evidence
    // weighs zero, the derived status is experience_degraded.
    const decision = await currentDecision(seeded);
    expect(decision.derivedStatus).toBe("experience_degraded");

    // ------------------------------------------------------------------
    // 4. Desired-state re-planning: the customer revises the intent
    //    (failover preferences), the compiler emits a NEW versioned
    //    command, and a failover contract is selected + activated +
    //    reserved through the boundary.
    // ------------------------------------------------------------------
    // §11 "manual interventions per session/day" (harness measurement
    // point): the revision below is a CUSTOMER-initiated intervention -
    // the automatic paths did not keep the experience usable, so the
    // customer stepped in and re-planned the desired state.
    world.slo.recorder.recordManualIntervention({ tenantId: customer.tenantId });
    await world.experience.intents.reviseIntent(
      world.envelope({ ...actor, intentVersion: 2 }),
      {
        intentId,
        payload: journeyIntentPayload({
          preferences: {
            reliability: "high",
            latency: "interactive",
            costSensitivity: "high",
            privacySensitivity: "high",
            preferredAccessClasses: ["home_cellular", "trusted_wifi"],
          },
        }),
        rationale: "Primary path degraded: prefer cellular failover, cap cost",
      },
    );
    const intentRecord = await world.experience.intents.getIntent(customer.tenantId, intentId);
    expect(intentRecord.currentVersionNumber).toBe(2);
    const versions = await world.experience.intents.listVersions(customer.tenantId, intentId);
    const revisedVersion = must(
      versions.find((version) => version.intentVersionId === intentRecord.currentVersionId),
      "revised intent version",
    );
    const recompiled = compileExperienceIntent(intentRecord.toRecord(), revisedVersion, {
      at: world.clock.now(),
      commandId: world.ids.next(),
      actorId: customer.actorId,
    });
    expect(recompiled.payload.sourceIntentVersionNumber).toBe(2);
    // The revised command is a DIFFERENT compilation (different digest, so a
    // different derived idempotency key - no collision with v1).
    const failoverSubmission = await world.adcos.intents.submit(
      recompiled.payload as unknown as IntentCommandInput,
    );
    const failoverIntentId = (failoverSubmission.document as Record<string, unknown>)["id"] as string;
    const context = {
      actorId: customer.actorId,
      tenantId: customer.tenantId,
      correlationId: world.correlation.next(),
    };
    const failoverContract = await world.adcos.offers.selectOffers(
      failoverIntentId,
      { offers: [{ offer: "offer-ghana-failover-cellular" }], recorded_at: world.clock.now() },
      context,
    );
    const failoverContractId = (failoverContract.document as Record<string, unknown>)["id"] as string;
    await world.adcos.offers.activateContract(
      failoverIntentId,
      {
        activated_at: world.clock.now(),
        signature_refs: [parseAdcosSignatureRef("sig-failover-1")],
      },
      context,
    );
    const failoverLease = await world.adcos.offers.createReservation(
      failoverContractId,
      { granted_at: world.clock.now() },
      context,
    );
    const failoverLeaseId = (failoverLease.document as Record<string, unknown>)["id"] as string;
    expect((failoverLease.document as Record<string, unknown>)["status"]).toBe("granted");
    // §11 "provider/access failover success" (harness measurement point):
    // the failover attempt's outcome is the granted failover reservation on
    // the re-planned access path (the relink below confirms usable truth).
    world.slo.recorder.recordProviderAccessFailover({
      tenantId: customer.tenantId,
      succeeded: true,
    });
    const failoverSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === PROVIDER_ACCESS_FAILOVER_SUCCESS_METRIC);
    expect(failoverSamples).toHaveLength(1);
    expect((failoverSamples[0]?.labels as Record<string, unknown>)["outcome"]).toBe("good");

    // The failover's own events arrive and project (the new truth is FRESH).
    await world.admitAndProject();
    const failoverProjection = await world.boundary.projections.get(
      "connectivity_contract",
      failoverContractId,
    );
    expect(failoverProjection?.freshness_state).toBe("FRESH");
    expect((failoverProjection?.payload as Record<string, unknown>)["event_type"]).toBe(
      "connectivity_contract.activated",
    );

    // ------------------------------------------------------------------
    // 5. Reconciliation REPAIRS the missed signal (RL-035): the stale old
    //    contract is re-read canonically; the projection is repaired to
    //    DEGRADED with AUTHENTICATED evidence and a digest-verified payload.
    // ------------------------------------------------------------------
    const job = await world.boundary.reconciler.runJob({
      reason: "manual",
      correlationId: world.correlation.next(),
    });
    expect(job.status).toBe("COMPLETED");
    const repairAction = job.actions.find(
      (action) =>
        action.action_type === "CANONICAL_REFRESH" &&
        action.resource_id === contractId &&
        action.outcome === "REPAIRED",
    );
    expect(repairAction).toBeDefined();

    const repaired = await world.boundary.projections.get("connectivity_contract", contractId);
    expect(repaired?.freshness_state).toBe("FRESH");
    expect(repaired?.evidence_class).toBe("AUTHENTICATED");
    expect((repaired?.payload as Record<string, unknown>)["state"]).toBe("DEGRADED");
    // Digest-verified repair: the payload digest matches the canonical body.
    expect(repaired?.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    // The repair ADVANCED the projection version (monotone, no rewrite).
    expect(repaired?.projection_version).toBeGreaterThan(2);

    // §11 "successful automatic recovery rate" + "stale/unknown-state
    // duration" (PRODUCT measurement point, RL-035 -> RL-052 wiring): the
    // boundary was constructed with the world's product-SLO recorder as its
    // SLO observer, so the completed job's DURABLE actions were emitted
    // automatically - one good recovery per REPAIRED canonical refresh, plus
    // the CLOSED stale window duration (repair instant - fresh_until of the
    // pre-repair record) per stale-window-closing repair, plus ONE manual
    // intervention for the human-triggered repair loop (reason "manual").
    const repairedActions = job.actions.filter(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.outcome === "REPAIRED",
    );
    expect(repairedActions.length).toBeGreaterThanOrEqual(1);
    const recoverySamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC);
    expect(recoverySamples).toHaveLength(repairedActions.length);
    expect(
      recoverySamples.every(
        (sample) => (sample.labels as Record<string, unknown>)["outcome"] === "good",
      ),
    ).toBe(true);
    const recoverySlo = evaluateProductSlo(
      world.slo.recorder,
      "successful-automatic-recovery-rate",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(recoverySlo.good).toBe(repairedActions.length);
    expect(recoverySlo.bad).toBe(0);
    expect(recoverySlo.state).toBe("within-budget");

    // The stale-window durations the engine measured from the projections'
    // own freshness fields: every repair that closed a stale window emitted
    // its full duration (aging past the 60s event TTL), stamped into the
    // DURABLE action metrics and recorded verbatim - never guessed.
    const staleDurationSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === STALE_UNKNOWN_STATE_DURATION_MS_METRIC);
    const closedWindowActions = repairedActions.filter(
      (action) => (action.metrics as Record<string, unknown> | undefined)?.["staleForMs"] !== undefined,
    );
    expect(staleDurationSamples).toHaveLength(closedWindowActions.length);
    expect(closedWindowActions.length).toBeGreaterThanOrEqual(1);
    for (const action of closedWindowActions) {
      expect((action.metrics as Record<string, number>)["staleForMs"]).toBe(
        AGING_ADVANCE_MS - 60_000,
      );
    }
    expect(
      staleDurationSamples.every(
        (sample) =>
          (sample as { value: number }).value === AGING_ADVANCE_MS - 60_000 &&
          (sample.labels as Record<string, unknown>)["freshness_state"] === "stale",
      ),
    ).toBe(true);
    const staleDurationSlo = evaluateProductSlo(
      world.slo.recorder,
      "stale-unknown-state-duration",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(staleDurationSlo.total).toBe(closedWindowActions.length);
    expect(staleDurationSlo.state).toBe("exhausted"); // honestly over budget: the window exceeded the harness's 120s threshold

    // ------------------------------------------------------------------
    // 6. The customer SEES the truth: the reference relinks to the
    //    failover contract. The old contract's DEGRADED truth stays in its
    //    own projection (history is not rewritten), and the reference
    //    history retains BOTH observations (audit).
    // ------------------------------------------------------------------
    const historyBefore = await world.references.referenceHistory(
      customer.tenantId,
      referenceId,
    );
    const relinked = await world.references.linkDeliveryEvidence(
      world.envelope(actor),
      {
        referenceId,
        expectedRevision: seeded.referenceRevision,
        canonicalResourceType: "connectivity_contract",
        canonicalResourceId: failoverContractId,
      },
    );
    expect(relinked.deliveryEvidenceState).toBe("EVIDENCED");
    expect(relinked.freshnessState).toBe("FRESH");

    // §11 "minutes without usable connectivity" (harness measurement): the
    // outage window closes HERE - the relink restored FRESH, EVIDENCED,
    // AUTHENTICATED usable truth. The recorded minutes span the customer's
    // non-usable period (guarantee expiry -> failover relink).
    const usableAgainAt = world.clock.now();
    const minutesWithoutUsable = msBetween(notUsableSince, usableAgainAt) / 60_000;
    expect(minutesWithoutUsable).toBeCloseTo((AGING_ADVANCE_MS - 60_000) / 60_000, 9);
    world.slo.recorder.recordMinutesWithoutUsableConnectivity({
      tenantId: customer.tenantId,
      minutes: minutesWithoutUsable,
    });
    const minutesSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === MINUTES_WITHOUT_USABLE_CONNECTIVITY_METRIC);
    expect(minutesSamples).toHaveLength(1);
    expect((minutesSamples[0] as { value: number }).value).toBeCloseTo(
      (AGING_ADVANCE_MS - 60_000) / 60_000,
      9,
    );

    // §11 "manual interventions per session/day" (total for the session):
    // the CUSTOMER's intent re-planning + the OPERATOR's manual
    // reconciliation trigger (the engine emitted that one automatically
    // from the job's durable trigger_reason) - two recorded interventions,
    // each honestly classified against the harness budget (max 2/day).
    const manualSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === MANUAL_INTERVENTIONS_PER_SESSION_DAY_METRIC);
    expect(manualSamples).toHaveLength(2);
    expect(
      manualSamples.every(
        (sample) => (sample as { delta: number }).delta === 1,
      ),
    ).toBe(true);
    const manualSlo = evaluateProductSlo(
      world.slo.recorder,
      "manual-interventions-per-session-day",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(manualSlo.good).toBe(2);
    expect(manualSlo.state).toBe("within-budget");

    view = await world.references.describeSubject(
      customer.tenantId,
      "order",
      seeded.orderId as never,
    );
    expect(view.evidence?.canonicalResourceId).toBe(failoverContractId);
    expect(view.evidence?.freshness.freshnessState).toBe("FRESH");
    // The old contract's projection still tells its own truth.
    const stillDegraded = await world.boundary.projections.get(
      "connectivity_contract",
      contractId,
    );
    expect((stillDegraded?.payload as Record<string, unknown>)["state"]).toBe("DEGRADED");
    // The reference event chain keeps every observation (RL-LOCK-010 audit).
    const historyAfter = await world.references.referenceHistory(
      customer.tenantId,
      referenceId,
    );
    expect(historyAfter.length).toBe(historyBefore.length + 1);

    // The decision recovers with the evidence: the device re-observes post-
    // failover (fresh, healthy evidence) and the revised intent (v2) reads
    // supported again - evidence-weighted, never fabricated.
    const recoveryAt = world.clock.now();
    await world.experience.registry.recordCapabilitySnapshot(world.envelope(actor), {
      deviceId,
      platform: { family: "ios", platformVersion: "18.2" },
      observedAt: recoveryAt,
      freshUntil: instantPlusMs(recoveryAt, SNAPSHOT_WINDOW_MS),
      capabilities: {
        wifi_observation: { status: "available", evidenceClass: "OBSERVED", observedAt: recoveryAt },
        cellular_data_sim_selection: {
          status: "available",
          evidenceClass: "OBSERVED",
          observedAt: recoveryAt,
        },
        active_interface_selection: {
          status: "available",
          evidenceClass: "OBSERVED",
          observedAt: recoveryAt,
        },
        radio_os_telemetry: { status: "available", evidenceClass: "OBSERVED", observedAt: recoveryAt },
      },
    });
    await world.experience.registry.recordContextSnapshot(world.envelope(actor), {
      deviceId,
      ownerUserId: customer.userId,
      observedAt: recoveryAt,
      freshUntil: instantPlusMs(recoveryAt, SNAPSHOT_WINDOW_MS),
      consent: { fineLocationGranted: false },
      payload: {
        network: { visibleWifiNetworkCount: 2, cellularRadio: "lte", vpnActive: false },
        battery: { levelPercent: 71, charging: false },
      },
    });
    const capabilitySnapshot =
      (await world.experience.registry.latestCapabilitySnapshot(customer.tenantId, deviceId)) ??
      null;
    const contextSnapshot =
      (await world.experience.registry.latestContextSnapshot(customer.tenantId, deviceId)) ?? null;
    const recovered = buildExperienceDecision({
      decisionId: parseExperienceDecisionId(world.ids.next()),
      intent: intentRecord.toRecord(),
      intentVersion: revisedVersion,
      capabilitySnapshot,
      contextSnapshot,
      at: world.clock.now(),
    });
    expect(recovered.derivedStatus).toBe("experience_supported");
    expect(recovered.subject.versionNumber).toBe(2);

    // The failover lease id is a distinct reservation (no reuse of the old one).
    expect(failoverLeaseId).not.toBe(seeded.leaseId);
  });

  it("when canonical truth is UNREACHABLE the reconciler degrades honestly instead of guessing (RL-035/010)", async () => {
    const seeded = await seedActiveConnectivity(makeJourneyWorld("degraded-unreachable"));
    const { world, customer, contractId } = seeded;

    // Truth becomes unreachable AND the projection ages past its TTL.
    world.fake.silentStateChange(contractId, "DEGRADED");
    world.fake.failNext({ kind: "transport", outcome: "not-sent" }, { count: 100 });
    world.clock.advanceBy(AGING_ADVANCE_MS);

    const job = await world.boundary.reconciler.runJob({
      reason: "scheduled",
      correlationId: world.correlation.next(),
    });
    expect(job.status).toBe("COMPLETED");
    // Bounded canonical-read attempts (policy max attempts per target):
    const targetActions = job.actions.filter(
      (action) => action.action_type === "CANONICAL_REFRESH" && action.resource_id === contractId,
    );
    expect(targetActions).toHaveLength(1);
    expect(targetActions[0]?.attempts).toBeLessThanOrEqual(3);
    expect(["DEGRADED_STALE", "DEGRADED_UNKNOWN", "DEFERRED"]).toContain(targetActions[0]?.outcome);

    // The projection tells the truth about not knowing: STALE (the aged
    // observation), never a fabricated state, never FRESH. The payload is
    // still the LAST HONEST SIGNAL (the activation event) - degradation is
    // not guessed from silence.
    const projection = await world.boundary.projections.get("connectivity_contract", contractId);
    expect(projection?.freshness_state).toBe("STALE");
    expect((projection?.payload as Record<string, unknown>)["event_type"]).toBe(
      "connectivity_contract.activated",
    );
    expect(projection?.payload_digest).toMatch(/^[0-9a-f]{64}$/);

    // The customer's read model agrees: evidence re-evaluated STALE at the
    // query instant - stale-while-degraded, the last honest observation.
    const view = await world.references.describeSubject(
      customer.tenantId,
      "order",
      seeded.orderId as never,
    );
    expect(view.evidence?.freshness.freshnessState).toBe("STALE");

    // §11 honesty: unreachable truth produced NO fabricated recovery - the
    // product wiring recorded ZERO automatic-recovery events for a job whose
    // canonical refresh attempts all deferred (the system degraded
    // honestly instead of claiming a repair).
    const unreachableRecoverySamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC);
    expect(unreachableRecoverySamples).toHaveLength(0);
  });
});

/** The decision recomputed from the intent + the LATEST registry evidence. */
async function currentDecision(seeded: ActiveConnectivity) {
  const { world, customer, intentId, deviceId } = seeded;
  const intentRecord = await world.experience.intents.getIntent(customer.tenantId, intentId);
  const versions = await world.experience.intents.listVersions(customer.tenantId, intentId);
  const currentVersion = must(
    versions.find((version) => version.intentVersionId === intentRecord.currentVersionId),
    "current intent version",
  );
  return buildExperienceDecision({
    decisionId: parseExperienceDecisionId(world.ids.next()),
    intent: intentRecord.toRecord(),
    intentVersion: currentVersion,
    capabilitySnapshot:
      (await world.experience.registry.latestCapabilitySnapshot(customer.tenantId, deviceId)) ??
      null,
    contextSnapshot:
      (await world.experience.registry.latestContextSnapshot(customer.tenantId, deviceId)) ??
      null,
    at: world.clock.now(),
  });
}
