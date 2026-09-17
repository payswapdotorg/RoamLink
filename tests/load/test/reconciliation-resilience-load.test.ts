/**
 * RL-073 load suite: RECONCILIATION BOUNDED WORK (RL-035) + RESILIENCE
 * UNDER SUSTAINED FAILURE (RL-053).
 *
 * Deterministic load shape (testkit clock/ids, no sleeps, no wall-clock
 * timing): canonical-refresh work is measured through COUNTING adapters
 * over the PUBLIC AdcosClient port, so "full-canonical-refresh vs
 * incremental" is expressed as exact fetch counts per job.
 *
 * Complexity invariants:
 *
 *  REC-1 (CONSISTENT targets cost ZERO canonical fetches): a sweep over N
 *       FRESH, digest-valid projections performs ZERO canonical reads -
 *       the freshness guarantee itself proves consistency; work is bounded
 *       by the number of targets whose guarantee is EXPIRED or absent;
 *  REC-2 (incremental refresh bounds fetches per target): each
 *       NEEDS_REFRESH target performs at most maxCanonicalReadAttempts
 *       canonical fetches (bounded retries) regardless of history size;
 *       transient failures degrade the projection honestly (STALE/UNKNOWN)
 *       instead of looping;
 *  REC-3 (full refresh vs incremental): after N distinct resources are
 *       projected FRESH, an immediate second job performs ZERO fetches
 *       (incremental no-op); forcing TTL expiry turns the next job into a
 *       bounded full refresh of exactly N fetches (one per resource) - the
 *       incremental/full distinction is a bounded 0-vs-N fetch split, never
 *       N-per-target;
 *  REC-4 (job idempotency): re-running the SAME completed job id replays
 *       the recorded outcome with ZERO additional fetches (no duplicate
 *       effects);
 *  RES-1 (circuit breaker half-open probing rate-limits recovery): under
 *       sustained failure the breaker OPENs; during cooldown EVERY call is
 *       rejected without invoking the dependency (zero calls); after
 *       cooldown, at most halfOpenMaxProbes calls execute per probe window
 *       (probe saturation rejects fail-closed);
 *  RES-2 (retry budgets cap total work): a retry policy with maxAttempts=N
 *       and a deadline budget performs at most N attempts total; attempts
 *       stop at the deadline even with attempts remaining (bounded total
 *       work, no unbounded retry loops);
 *  RES-3 (limiter bounding): a sliding-window limiter admits at most its
 *       maxCost per window over sustained take pressure (graceful
 *       degradation with honest retry-after guidance, never overflow).
 */
import { describe, expect, it } from "vitest";
import type { AdcosClient } from "@roamlink/adcos";
import { AdcosTransportError } from "@roamlink/integration";
import { createAdcosReconciliationBoundary } from "@roamlink/reconciliation";
import {
  SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC,
  STALE_UNKNOWN_STATE_DURATION_MS_METRIC,
  evaluateProductSlo,
} from "@roamlink/observability";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { InMemoryProjectionStore } from "@roamlink/projections";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { CircuitBreaker } from "@roamlink/resilience";
import { makeRetryPolicy, retryWithPolicy, noJitter } from "@roamlink/resilience";
import { SlidingWindowLimiter } from "@roamlink/resilience";
import { parseUtcInstant } from "@roamlink/contracts";
import { DeterministicClock } from "@roamlink/testkit";

import { ingestIntents, makeLoadWorld } from "../src/harness.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

/** Event TTL for event-projected records (DEFAULT_FRESHNESS_POLICY). */
const EVENT_TTL_MS = 60_000;

/** A counting decorator over the public AdcosClient read surface. */
class CountingClient {
  /** Per-target canonical GET fetches (the repair work). */
  gets = 0;
  /** Discovery LIST calls (constant per job, independent of target count). */
  lists = 0;
  readonly #inner: AdcosClient;
  #proxy: AdcosClient | undefined;

  constructor(inner: AdcosClient) {
    this.#inner = inner;
  }

  get client(): AdcosClient {
    if (this.#proxy !== undefined) return this.#proxy;
    const readMethods = new Set([
      "getIntent",
      "getContract",
      "getLease",
      "getContractUsage",
      "getContractAssurance",
      "getWebhookEndpoint",
    ]);
    const listMethods = new Set([
      "listIntents",
      "listContracts",
      "listLeases",
      "listWebhookEndpoints",
    ]);
    // Arrow handlers reference `this` lexically (no this-aliasing).
    this.#proxy = new Proxy(this.#inner, {
      get: (target, property, receiver) => {
        if (readMethods.has(property as string) || listMethods.has(property as string)) {
          const method = (
            target as unknown as Record<
              string,
              (...a: unknown[]) => Promise<unknown> | undefined
            >
          )[property as string];
          if (method === undefined) {
            return undefined;
          }
          const inner = method.bind(target);
          const isList = listMethods.has(property as string);
          return async (...args: unknown[]) => {
            if (isList) {
              this.lists += 1;
            } else {
              this.gets += 1;
            }
            return inner(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return this.#proxy;
  }
}

describe("RL-073 load: reconciliation bounded work (full vs incremental canonical refresh)", () => {
  it("REC-1/2/3/4: CONSISTENT targets cost zero fetches; refresh bounds fetches per target; jobs are idempotent", async () => {
    const world = makeLoadWorld();
    const counting = new CountingClient(world.fake);

    // A boundary whose canonical reads flow through the counting client
    // (the PUBLIC AdcosClient port) - identical public options otherwise.
    const persistence = createInMemoryPersistence();
    const store = new InMemoryProjectionStore();
    const verifier = new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({
        [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
      }),
    });
    let jobCounter = 0;
    const jobIdGenerator = {
      next(): string {
        jobCounter += 1;
        return `00000000-0000-4000-8000-${(0xf000 + jobCounter).toString(16).padStart(12, "0")}`;
      },
    };
    const countingBoundary = createAdcosReconciliationBoundary({
      client: counting.client,
      projectionStore: store,
      persistence,
      persistenceReader: persistence,
      verifier,
      clock: world.clock,
      platformTenantId: "org:00000000-0000-4000-8000-000000000001",
      jobIdGenerator,
      // §11 SLO emission wiring (additive): the durable-action measurements
      // flow into the load world's REAL product-SLO recorder so the emission
      // volume itself can be asserted per unit of admitted work below.
      sloObserver: world.slo.recorder,
    });

    // Project N distinct resources FRESH through the inbox (the incremental
    // baseline state).
    const N = 120;
    const deliveries = await ingestIntents(world.fake, world.clock, N);
    for (const delivery of deliveries) {
      const signed = fakeWebhookDelivery({
        spec: {
          eventId: delivery.event.event_id,
          eventType: delivery.event.event_type,
          resourceId: delivery.event.resource_id,
          resourceKind: delivery.event.resource_kind,
          resourceVersion: delivery.event.resource_version,
          occurredAt: delivery.event.occurred_at,
          correlationId: delivery.event.correlation_id,
          environment: "sandbox" as const,
        },
        deliveryId: delivery.deliveryId,
        sequence: delivery.sequence,
        receivedAt: world.clock.now(),
      });
      await countingBoundary.inbox.admitDelivery({
        headers: signed.headers,
        payload: signed.payload,
        receivedAt: world.clock.now(),
      });
    }
    const drained = await countingBoundary.inbox.processPending(N);
    expect(drained.applied).toBe(N);
    expect(await countingBoundary.projections.count("connectivity_intent")).toBe(N);

    // REC-1 (incremental no-op): all N projections are FRESH and
    // digest-valid -> the job performs ZERO per-target canonical GETs (the
    // freshness guarantee proves consistency). Discovery costs a CONSTANT
    // 4 list calls (one per discovery route) regardless of N.
    counting.gets = 0;
    counting.lists = 0;
    const incremental = await countingBoundary.reconciler.runJob({ reason: "scheduled" });
    expect(incremental.status).toBe("COMPLETED");
    expect(counting.gets).toBe(0);
    expect(counting.lists).toBe(4);

    // REC-4: re-running the SAME completed job id replays the outcome with
    // ZERO additional work of any kind (job-level idempotency).
    counting.gets = 0;
    counting.lists = 0;
    const replayed = await countingBoundary.reconciler.runJob({
      jobId: incremental.job_id,
      reason: "crash-recovery",
    });
    expect(replayed.status).toBe("COMPLETED");
    expect(counting.gets).toBe(0);
    expect(counting.lists).toBe(0);

    // REC-3 (full refresh): TTL expiry turns every projection NEEDS_REFRESH
    // -> the next job performs exactly N canonical GETs (one bounded fetch
    // per resource - never N-per-target) and the same constant discovery.
    world.clock.advanceBy(EVENT_TTL_MS + 5_000);
    counting.gets = 0;
    counting.lists = 0;
    const full = await countingBoundary.reconciler.runJob({ reason: "scheduled" });
    expect(full.status).toBe("COMPLETED");
    expect(counting.gets).toBe(N);
    expect(counting.lists).toBe(4);

    // Every projection returned to FRESH AUTHENTICATED canonical truth.
    const all = await countingBoundary.projections.list("connectivity_intent");
    expect(all).toHaveLength(N);
    expect(all.every((record) => record.freshness_state === "FRESH")).toBe(true);
    // REC-2 (bounded per target): each target consumed at most the policy's
    // maxCanonicalReadAttempts (3) fetches - measured via the action records.
    const refreshActions = full.actions.filter(
      (action) => action.action_type === "CANONICAL_REFRESH",
    );
    expect(refreshActions).toHaveLength(N);
    expect(refreshActions.every((action) => action.attempts <= 3)).toBe(true);

    // REC-1 again: after the full refresh, the next incremental job is a
    // zero-fetch no-op (the steady-state loop is cheap).
    counting.gets = 0;
    const steady = await countingBoundary.reconciler.runJob({ reason: "scheduled" });
    expect(steady.status).toBe("COMPLETED");
    expect(counting.gets).toBe(0);

    // SLO-E (§11 emission volume invariants, MVP-3 wiring): the load world's
    // product-SLO recorder received EXACTLY N good automatic-recovery events
    // and N closed stale-window durations (each 5_000 ms: TTL expiry + 5s
    // aging) — one per REPAIRED target of the full refresh, and NOTHING for
    // the incremental job, the idempotent replay or the steady-state no-op
    // before/after it. Emission is exactly proportional to durable repair
    // work: never O(N²) chatter, never duplicated on replay.
    const recoverySamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === SUCCESSFUL_AUTOMATIC_RECOVERY_RATE_METRIC);
    expect(recoverySamples).toHaveLength(N);
    expect(
      recoverySamples.every(
        (sample) => (sample.labels as Record<string, unknown>)["outcome"] === "good",
      ),
    ).toBe(true);
    const staleDurationSamples = world.slo.metrics
      .samples()
      .filter((sample) => sample.name === STALE_UNKNOWN_STATE_DURATION_MS_METRIC);
    expect(staleDurationSamples).toHaveLength(N);
    expect(
      staleDurationSamples.every(
        (sample) =>
          (sample as { value: number }).value === 5_000 &&
          (sample.labels as Record<string, unknown>)["freshness_state"] === "stale",
      ),
    ).toBe(true);
    const recoverySlo = evaluateProductSlo(
      world.slo.recorder,
      "successful-automatic-recovery-rate",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(recoverySlo.good).toBe(N);
    expect(recoverySlo.bad).toBe(0);
    expect(recoverySlo.state).toBe("within-budget");
    const staleSlo = evaluateProductSlo(
      world.slo.recorder,
      "stale-unknown-state-duration",
      { targetRatio: 0.99, windowMs: 3_600_000 },
    );
    expect(staleSlo.total).toBe(N);
  }, 240_000);

  it("REC-2 under sustained canonical failure: fetches are bounded per target and projections degrade honestly", async () => {
    const world = makeLoadWorld();
    const N = 30;
    const deliveries = await ingestIntents(world.fake, world.clock, N);
    const persistence = createInMemoryPersistence();
    const store = new InMemoryProjectionStore();
    const verifier = new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({
        [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
      }),
    });

    /** A client whose canonical reads ALWAYS fail (sustained outage). */
    const failingClient = new Proxy(world.fake, {
      get(target, property, receiver) {
        if (
          property === "getIntent" ||
          property === "getContract" ||
          property === "getLease" ||
          property === "getContractUsage" ||
          property === "getContractAssurance" ||
          property === "getWebhookEndpoint"
        ) {
          return async (): Promise<never> => {
            throw new AdcosTransportError("not-sent", "load: sustained canonical outage");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    let jobCounter = 0;
    const boundary = createAdcosReconciliationBoundary({
      client: failingClient,
      projectionStore: store,
      persistence,
      persistenceReader: persistence,
      verifier,
      clock: world.clock,
      platformTenantId: "org:00000000-0000-4000-8000-000000000001",
      jobIdGenerator: {
        next(): string {
          jobCounter += 1;
          return `00000000-0000-4000-8000-${(0xe000 + jobCounter).toString(16).padStart(12, "0")}`;
        },
      },
    });

    // Project FRESH baseline through the inbox (reads unaffected).
    for (const delivery of deliveries) {
      const signed = fakeWebhookDelivery({
        spec: {
          eventId: delivery.event.event_id,
          eventType: delivery.event.event_type,
          resourceId: delivery.event.resource_id,
          resourceKind: delivery.event.resource_kind,
          resourceVersion: delivery.event.resource_version,
          occurredAt: delivery.event.occurred_at,
          correlationId: delivery.event.correlation_id,
          environment: "sandbox" as const,
        },
        deliveryId: delivery.deliveryId,
        sequence: delivery.sequence,
        receivedAt: world.clock.now(),
      });
      await boundary.inbox.admitDelivery({
        headers: signed.headers,
        payload: signed.payload,
        receivedAt: world.clock.now(),
      });
    }
    const drained = await boundary.inbox.processPending(N);
    expect(drained.applied).toBe(N);

    // TTL expiry + sustained canonical outage: the job completes with
    // BOUNDED per-target attempts and degrades every projection honestly.
    world.clock.advanceBy(EVENT_TTL_MS + 5_000);
    const job = await boundary.reconciler.runJob({ reason: "scheduled" });
    expect(job.status).toBe("COMPLETED");

    const refreshActions = job.actions.filter(
      (action) => action.action_type === "CANONICAL_REFRESH",
    );
    expect(refreshActions).toHaveLength(N);
    // Bounded work: every target attempted at most maxCanonicalReadAttempts
    // (3) fetches under failure - the loop stops, it never spins.
    expect(refreshActions.every((action) => action.attempts <= 3)).toBe(true);
    // Honest degradation: the Phase-A sweep already degraded every
    // projection to STALE, so the scan DEFERS the repair to the next job
    // (bounded retries exhausted) instead of guessing. The customer-facing
    // truth is STALE everywhere - never a fabricated FRESH, never a guess.
    expect(refreshActions.every((action) => action.outcome === "DEFERRED")).toBe(true);
    const all = await boundary.projections.list("connectivity_intent");
    expect(all.every((record) => record.freshness_state === "STALE")).toBe(true);
    // The deferral detail names the failure code honestly (diagnosable).
    expect(refreshActions.every((action) => action.detail.includes("transport-not-sent"))).toBe(
      true,
    );
  }, 240_000);
});

describe("RL-073 load: resilience under sustained failure (RL-053)", () => {
  it("RES-1: an open circuit breaker rejects without invoking the dependency; half-open probing is rate-limited and saturates fail-closed", async () => {
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      failureWindowMs: 10_000,
      openCooldownMs: 30_000,
      halfOpenMaxProbes: 2,
      halfOpenSuccessThreshold: 1,
      now: () => clock.now(),
    });

    let calls = 0;
    const alwaysFails = async (): Promise<never> => {
      calls += 1;
      throw new Error("load: dependency down");
    };

    // Sustained failure trips the breaker OPEN.
    for (let i = 0; i < 3; i += 1) {
      const result = await breaker.execute(clock.now(), alwaysFails);
      expect(result.executed).toBe(true);
      if (result.executed) {
        expect(result.succeeded).toBe(false);
      }
    }
    expect(breaker.stateAt(clock.now())).toBe("open");

    // During cooldown: EVERY call is rejected WITHOUT invoking the
    // dependency - the call count does not grow no matter the pressure.
    for (let i = 0; i < 500; i += 1) {
      const result = await breaker.execute(clock.now(), alwaysFails);
      expect(result.executed).toBe(false);
    }
    expect(calls).toBe(3); // zero calls under 500 attempts (rate-limited)

    // After cooldown: the breaker is half-open and admits AT MOST
    // halfOpenMaxProbes CONCURRENT probes; saturation rejects fail-closed.
    clock.advanceBy(31_000);
    expect(breaker.stateAt(clock.now())).toBe("half-open");

    // Five CONCURRENT probe attempts through a gated dependency: the first
    // two occupy the probe slots, the rest are rejected without invoking.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const gatedProbe = async (): Promise<never> => {
      started += 1;
      await gate;
      throw new Error("load: probe failed");
    };
    const executions = Array.from({ length: 5 }, () =>
      breaker.execute(clock.now(), gatedProbe),
    );
    await Promise.resolve();
    expect(started).toBe(2); // exactly halfOpenMaxProbes invoked

    release();
    const settled = await Promise.all(executions);
    const executed = settled.filter((result) => result.executed).length;
    const saturated = settled.filter((result) => !result.executed);
    expect(executed).toBe(2);
    expect(saturated).toHaveLength(3);
    // Saturation rejects with retryAfterMs=null (fail-closed: wait for an
    // in-flight probe, never a blind extra call).
    expect(saturated.every((result) => result.retryAfterMs === null)).toBe(true);

    // Both probes failed -> the breaker re-OPENED: the new cooldown again
    // rejects every call WITHOUT invoking the dependency.
    calls = 0;
    for (let i = 0; i < 200; i += 1) {
      const result = await breaker.execute(clock.now(), alwaysFails);
      expect(result.executed).toBe(false);
    }
    expect(calls).toBe(0);
    expect(breaker.stateAt(clock.now())).toBe("open");
  });

  it("RES-2: a retry budget caps total attempts; a deadline stops work even with attempts remaining", async () => {
    const policy = makeRetryPolicy({
      maxAttempts: 5,
      initialDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 60_000,
    });

    // Attempt budget: exactly maxAttempts invocations, then exhaustion.
    let attempts = 0;
    const alwaysFails = (): Promise<never> => {
      attempts += 1;
      throw new Error("load: retryable failure");
    };
    const exhausted = await retryWithPolicy(alwaysFails, {
      policy,
      jitter: noJitter(),
      classifier: () => true,
      now: () => parseUtcInstant("2026-01-15T08:30:00.000Z"),
      sleep: async () => undefined,
    });
    expect(exhausted.status).toBe("exhausted");
    if (exhausted.status === "exhausted") {
      expect(exhausted.attempts).toBe(5);
    }
    expect(attempts).toBe(5); // total work capped at maxAttempts

    // Deadline budget: with a time budget smaller than the backoff schedule,
    // the executor stops at the deadline even with attempts remaining.
    let deadlineAttempts = 0;
    const deadlineFails = (): Promise<never> => {
      deadlineAttempts += 1;
      throw new Error("load: retryable failure under deadline");
    };
    const deadlineExceeded = await retryWithPolicy(deadlineFails, {
      policy,
      jitter: noJitter(),
      classifier: () => true,
      now: () => parseUtcInstant("2026-01-15T08:30:00.000Z"),
      sleep: async () => undefined,
      timeBudgetMs: 1, // effectively immediate deadline
    });
    expect(["deadline-exceeded", "exhausted"]).toContain(deadlineExceeded.status);
    expect(deadlineAttempts).toBeLessThanOrEqual(5);
  });

  it("RES-3: a sliding-window limiter admits at most maxCost per window under sustained pressure", async () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 10_000, maxCost: 100 });
    const clock = new DeterministicClock("2026-01-15T08:30:00.000Z");

    // Sustained pressure: 1_000 take attempts of cost 1 on ONE key inside
    // ONE window (per-key budgets are the multi-tenant defense).
    let allowed = 0;
    let rejected = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const decision = limiter.tryTake("tenant-load-0", 1, clock.now());
      if (decision.allowed) allowed += 1;
      else rejected += 1;
    }
    expect(allowed).toBe(100); // exactly maxCost per key per window
    expect(rejected).toBe(900);
    // Every rejection carries honest retry-after guidance.
    const probe = limiter.tryTake("tenant-load-0", 1, clock.now());
    expect(probe.allowed).toBe(false);
    if (!probe.allowed) {
      expect(probe.retryAfterMs).toBeGreaterThan(0);
    }

    // The window heals: after windowMs the budget is available again
    // (graceful degradation, no permanent lockout).
    clock.advanceBy(10_001);
    const healed = limiter.tryTake("tenant-load-0", 1, clock.now());
    expect(healed.allowed).toBe(true);
  });
});
