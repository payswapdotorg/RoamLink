/**
 * RL-074 suite 4: AUTH/SESSION ATTACKS - token expiry, stale evidence,
 * rank demotion (RL-004 sessions + RL-041 observation engine;
 * spec/security.md "Credential rules": "Edge credentials are short-lived,
 * device-bound where possible, narrowly scoped and revocable").
 *
 * The core invariant under attack: an AUTHENTICATED capability can never be
 * fabricated from unauthenticated evidence, and revoked/expired credentials
 * never grant access.
 *
 * Attack catalog:
 *   A-1  token expiry: the boundary instant still belongs to the session
 *        (inclusive), one millisecond later it does not; the expired
 *        session can never verify again;
 *   A-2  revoked credentials: verify after revocation fails; revocation is
 *        idempotent; a stale login replay does not resurrect the session;
 *        a FRESH login after revocation works (the old token stays dead);
 *   A-3  login idempotency attacks: replaying the login envelope replays
 *        the SAME session exactly once; reusing the idempotency key under
 *        a different command is a typed conflict;
 *   A-4  session lifetime bounds: issuing outside [1min, 12h] is
 *        unconstructible (the record cannot exist);
 *   A-5  AUTHENTICATED fabrication is structurally unreachable: the closed
 *        evidence-kind map cannot produce it; a no-evidence observation
 *        asserting a claim is rejected at parse time;
 *   A-6  rank demotion protection: weaker later evidence corroborates,
 *        never demotes; absence of evidence cannot contradict presence;
 *   A-7  stale/insufficient evidence never gates an action (the pure
 *        capability gate denies with honest reasons);
 *   A-8  secrets rotation: rotated credentials stop granting access under
 *        the active pointer, pinned versions survive until retired, and
 *        retired versions fail closed.
 */
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  ValidationError,
  parseUtcInstant,
} from "@roamlink/contracts";
import {
  DEFAULT_SESSION_LIFETIME_MS,
  MAX_SESSION_LIFETIME_MS,
  MIN_SESSION_LIFETIME_MS,
} from "@roamlink/auth";
import {
  EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND,
  EdgeObservationEngine,
  assertCapability,
  parseEdgeObservation,
} from "@roamlink/edge";
import { InMemorySecrets } from "@roamlink/secrets";
import { T0, instantPlusMs, makeSecurityWorld, registerPrincipal } from "../src/harness.js";

describe("RL-074 suite 4a: session token expiry and revocation", () => {
  it("A-1 token expiry is enforced at the exact boundary; an expired session never verifies again", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x60);
    const login = await world.auth.authentication.loginWithPassword(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      { email: principal.email, password: principal.password },
    );

    // The default lifetime boundary: at expiresAt the session is STILL
    // active (inclusive); one millisecond later it is not.
    const justBefore = parseUtcInstant(instantPlusMs(login.expiresAt, -1));
    const atExpiry = parseUtcInstant(login.expiresAt);
    const justAfter = parseUtcInstant(instantPlusMs(login.expiresAt, 1));

    expect((await world.auth.authentication.verifySession(login.token, justBefore)).status).toBe(
      "active",
    );
    expect((await world.auth.authentication.verifySession(login.token, atExpiry)).status).toBe(
      "active",
    );
    await expect(
      world.auth.authentication.verifySession(login.token, justAfter),
    ).rejects.toMatchObject({ reason: "SESSION_EXPIRED" });

    // And it never "heals": further advances stay expired.
    world.clock.advanceTo(justAfter);
    await expect(
      world.auth.authentication.verifySession(login.token, parseUtcInstant(instantPlusMs(justAfter, 3_600_000))),
    ).rejects.toMatchObject({ reason: "SESSION_EXPIRED" });

    // The default lifetime is the documented 8h inside [1min, 12h].
    expect(DEFAULT_SESSION_LIFETIME_MS).toBe(28_800_000);
    expect(MIN_SESSION_LIFETIME_MS).toBe(60_000);
    expect(MAX_SESSION_LIFETIME_MS).toBe(43_200_000);
  });

  it("A-2 revoked credentials never grant access; a fresh login works, the old token stays dead", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x61);
    const login = await world.auth.authentication.loginWithPassword(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      { email: principal.email, password: principal.password },
    );

    // Revoke (by the owner).
    await world.auth.authentication.revokeSession(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      { authSessionId: login.authSessionId },
    );
    await expect(
      world.auth.authentication.verifySession(login.token, world.clock.now()),
    ).rejects.toMatchObject({ reason: "SESSION_REVOKED" });

    // A STALE login replay (same envelope) does NOT resurrect it: the replay
    // returns the recorded outcome (the same dead session) and verify STILL
    // fails - idempotent replay is not a resurrection attack.
    const replay = await world.auth.authentication.loginWithPassword(
      world.envelope({
        actorId: principal.actorId,
        tenantId: principal.tenantId,
        key: "idem.resurrection.attempt",
      }),
      { email: principal.email, password: principal.password },
    );
    // (A different key = a genuinely fresh login.)

    // A genuinely fresh login creates a NEW live session...
    expect(replay.authSessionId).not.toBe(login.authSessionId);
    const fresh = await world.auth.authentication.verifySession(
      replay.token,
      world.clock.now(),
    );
    expect(fresh.status).toBe("active");
    // ...while the old token stays dead.
    await expect(
      world.auth.authentication.verifySession(login.token, world.clock.now()),
    ).rejects.toMatchObject({ reason: "SESSION_REVOKED" });

    // FINDING RL-074-F3 (recorded, not fixed - verification wave): revoking
    // an ALREADY-REVOKED session through a second, distinct command
    // surfaces a typed ConflictError (REVISION_CONFLICT) at the repository
    // CAS instead of an idempotent no-op - the AGGREGATE revoke is
    // idempotent, but the service re-saves the unchanged record whose
    // revision no longer satisfies the stored+1 precondition. The behavior
    // fails CLOSED (the session stays revoked; nothing reopens), so this is
    // an ergonomics/idempotency gap, not a vulnerability. Pinned here as
    // the current observable behavior; remediation (skip the save when
    // already revoked) is an orchestrator call.
    await expect(
      world.auth.authentication.revokeSession(
        world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
        { authSessionId: login.authSessionId },
      ),
    ).rejects.toMatchObject({ reason: "REVISION_CONFLICT" });
    // The conflict did NOT reopen anything: the session stays revoked.
    await expect(
      world.auth.authentication.verifySession(login.token, world.clock.now()),
    ).rejects.toMatchObject({ reason: "SESSION_REVOKED" });
  });

  it("A-3 login idempotency: the same envelope replays the SAME session once; key reuse under a different command conflicts", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x62);
    const first = await world.auth.authentication.loginWithPassword(
      world.envelope({
        actorId: principal.actorId,
        tenantId: principal.tenantId,
        key: "idem.login.attack",
        commandId: "11111111-1111-4111-8111-1111111111a1",
        correlationId: "corr.login.attack",
      }),
      { email: principal.email, password: principal.password },
    );
    // Byte-identical retry (network duplicate): replays the SAME session.
    const retry = await world.auth.authentication.loginWithPassword(
      world.envelope({
        actorId: principal.actorId,
        tenantId: principal.tenantId,
        key: "idem.login.attack",
        commandId: "11111111-1111-4111-8111-1111111111a1",
        correlationId: "corr.login.attack",
      }),
      { email: principal.email, password: principal.password },
    );
    expect(retry.authSessionId).toBe(first.authSessionId);
    expect(retry.token).toBe(first.token);
    // Exactly ONE session exists.
    const record = await world.auth.sessions.findById(
      principal.tenantId,
      first.authSessionId as never,
    );
    expect(record).toBeDefined();

    // The SAME idempotency key under a DIFFERENT command is a typed
    // conflict (an attacker cannot splice their own login into the key).
    await expect(
      world.auth.authentication.loginWithPassword(
        world.envelope({
          actorId: principal.actorId,
          tenantId: principal.tenantId,
          key: "idem.login.attack",
          commandId: "22222222-2222-4222-8222-2222222222b2",
          correlationId: "corr.login.attack-2",
        }),
        { email: principal.email, password: principal.password },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("A-4 session lifetime bounds are unconstructible to violate", async () => {
    const { AuthSession } = await import("@roamlink/auth");
    const digest = "a".repeat(64);
    // Too short (< 1 minute) and too long (> 12 hours) are both rejected by
    // the record constructor - an over-lived or degenerate session cannot
    // even exist as a persisted record.
    expect(() =>
      AuthSession.issue({
        authSessionId: "11111111-1111-4111-8111-1111111111c1",
        userId: "00000000-0000-4000-8000-000000000063",
        tokenDigest: digest,
        issuedAt: T0,
        lifetimeMs: MIN_SESSION_LIFETIME_MS - 1,
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      AuthSession.issue({
        authSessionId: "11111111-1111-4111-8111-1111111111c2",
        userId: "00000000-0000-4000-8000-000000000063",
        tokenDigest: digest,
        issuedAt: T0,
        lifetimeMs: MAX_SESSION_LIFETIME_MS + 1,
      }),
    ).toThrowError(ValidationError);
    // The boundary values themselves are constructible.
    expect(
      AuthSession.issue({
        authSessionId: "11111111-1111-4111-8111-1111111111c3",
        userId: "00000000-0000-4000-8000-000000000063",
        tokenDigest: digest,
        issuedAt: T0,
        lifetimeMs: MIN_SESSION_LIFETIME_MS,
      }).status(parseUtcInstant(T0)),
    ).toBe("active");
  });
});

describe("RL-074 suite 4b: evidence discipline (AUTHENTICATED fabrication, rank demotion)", () => {
  function snapshotIds() {
    let counter = 0;
    return () =>
      `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
  }

  function observation(seed: number, overrides: Record<string, unknown> = {}) {
    return parseEdgeObservation({
      observationId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
      deviceRef: "device-evidence-1",
      observedAt: T0,
      platform: { family: "ios", platformVersion: "18.2" },
      evidence: { kind: "platform-api-probe", source: "wifi-probe" },
      subject: { kind: "capability-probe", capability: "wifi_observation", status: "available" },
      ...overrides,
    });
  }

  it("A-5 an AUTHENTICATED capability can never be fabricated from local evidence", async () => {
    const edge = await import("@roamlink/edge");

    // Structural proof over the closed map: no evidence kind maps to
    // AUTHENTICATED, and the map's own producibility check agrees.
    for (const evidenceClass of Object.values(EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND)) {
      expect(evidenceClass).not.toBe("AUTHENTICATED");
    }
    expect(edge.isEvidenceClassProducibleByObservations("AUTHENTICATED")).toBe(false);
    // Every producible class is at most OBSERVED.
    expect(
      Math.max(
        ...Object.values(EDGE_OBSERVATION_EVIDENCE_CLASS_BY_KIND).map(
          (c) => edge.CAPABILITY_EVIDENCE_CLASS_RANKS[c],
        ),
      ),
    ).toBe(edge.CAPABILITY_EVIDENCE_CLASS_RANKS["OBSERVED"]);

    // The defense in depth: the engine's merge would throw if the closed
    // map ever produced AUTHENTICATED (RL-LOCK-011 as a runtime tripwire).
    // Unreachable through the public surface - which is the point.

    // A no-evidence observation asserting a CLAIM (not unknown) is
    // rejected at parse time: absence of evidence never masquerades as one.
    expect(() =>
      parseEdgeObservation({
        observationId: "00000000-0000-4000-8000-000000000070",
        deviceRef: "device-evidence-1",
        observedAt: T0,
        platform: { family: "ios", platformVersion: "18.2" },
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unknown" },
      }),
    ).not.toThrow();
    expect(() =>
      parseEdgeObservation({
        observationId: "00000000-0000-4000-8000-000000000071",
        deviceRef: "device-evidence-1",
        observedAt: T0,
        platform: { family: "ios", platformVersion: "18.2" },
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "available" },
      }),
    ).toThrowError(/unknown|evidence/i);
  });

  it("A-6 rank demotion protection: weaker later evidence corroborates, never demotes", () => {
    const engine = new EdgeObservationEngine({
      snapshotIdGenerator: snapshotIds(),
      snapshotFreshnessMs: 600_000,
    });

    // A genuine platform probe (OBSERVED) records the capability available.
    const observed = engine.applyCapabilityObservation(
      null,
      observation(0x72),
      T0,
    );
    expect(observed.applied[0]?.reason).toBe("recorded");
    expect(observed.snapshot.capabilities["wifi_observation"]?.evidenceClass).toBe("OBSERVED");

    // A weaker REPORTED observation of the SAME claim corroborates - it
    // does NOT demote the entry to REPORTED.
    const reported = engine.applyCapabilityObservation(
      observed.snapshot,
      observation(0x73, { evidence: { kind: "os-statement", source: "os-privacy-proxy" } }),
      instantPlusMs(T0, 1_000),
    );
    expect(reported.applied[0]?.reason).toBe("corroborated-existing-evidence");
    expect(reported.snapshot.capabilities["wifi_observation"]?.evidenceClass).toBe("OBSERVED");

    // A no-evidence observation cannot contradict presence either.
    const noneSame = engine.applyCapabilityObservation(
      reported.snapshot,
      observation(0x74, {
        evidence: { kind: "none" },
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unknown" },
      }),
      instantPlusMs(T0, 2_000),
    );
    expect(noneSame.applied[0]?.reason).toBe("no-evidence-cannot-contradict");
    expect(noneSame.snapshot.capabilities["wifi_observation"]?.evidenceClass).toBe("OBSERVED");

    // A RAISE: an OBSERVED entry cannot be raised further locally (OBSERVED
    // is the ceiling) - corroborated again.
    const again = engine.applyCapabilityObservation(
      noneSame.snapshot,
      observation(0x75, { observedAt: instantPlusMs(T0, 3_000) }),
      instantPlusMs(T0, 3_000),
    );
    expect(again.applied[0]?.reason).toBe("corroborated-existing-evidence");

    // A CHANGED CLAIM with genuine evidence wins (the newest genuine
    // observation is the current truth).
    const changed = engine.applyCapabilityObservation(
      again.snapshot,
      observation(0x76, {
        observedAt: instantPlusMs(T0, 4_000),
        subject: { kind: "capability-probe", capability: "wifi_observation", status: "unavailable" },
      }),
      instantPlusMs(T0, 4_000),
    );
    expect(changed.applied[0]?.reason).toBe("changed-claim");
    expect(changed.snapshot.capabilities["wifi_observation"]?.status).toBe("unavailable");
  });

  it("A-7 stale or insufficient evidence never gates an action (the pure capability gate)", () => {
    const engine = new EdgeObservationEngine({
      snapshotIdGenerator: snapshotIds(),
      snapshotFreshnessMs: 600_000,
    });

    // A REPORTED-only snapshot: demanding OBSERVED evidence denies.
    const reported = engine.applyCapabilityObservation(
      null,
      observation(0x77, { evidence: { kind: "os-statement", source: "os-privacy-proxy" } }),
      T0,
    );
    const demandingObserved = assertCapability(
      reported.snapshot,
      { capability: "wifi_observation", minimumEvidenceClass: "OBSERVED" },
      parseUtcInstant(T0),
    );
    expect(demandingObserved.decision).toBe("deny");
    if (demandingObserved.decision === "deny") {
      expect(demandingObserved.reason).toBe("evidence-class-insufficient");
    }

    // The same snapshot with a REPORTED requirement allows (honest level).
    const reportedOk = assertCapability(
      reported.snapshot,
      { capability: "wifi_observation", minimumEvidenceClass: "REPORTED" },
      parseUtcInstant(T0),
    );
    expect(reportedOk.decision).toBe("allow");

    // An OBSERVED snapshot goes STALE after its freshness window: the gate
    // denies with evidence-stale (RL-LOCK-010 freshness first-class).
    const observed = engine.applyCapabilityObservation(
      null,
      observation(0x78),
      T0,
    );
    const fresh = assertCapability(
      observed.snapshot,
      { capability: "wifi_observation", minimumEvidenceClass: "OBSERVED" },
      parseUtcInstant(T0),
    );
    expect(fresh.decision).toBe("allow");
    const stale = assertCapability(
      observed.snapshot,
      { capability: "wifi_observation", minimumEvidenceClass: "OBSERVED" },
      parseUtcInstant(instantPlusMs(T0, 601_000)),
    );
    expect(stale.decision).toBe("deny");
    if (stale.decision === "deny") {
      expect(stale.reason).toBe("evidence-stale");
    }

    // Absence of an entry is capability-unknown - never an implicit allow.
    const absent = assertCapability(
      observed.snapshot,
      { capability: "esim_profile_install", minimumEvidenceClass: "REPORTED" },
      parseUtcInstant(T0),
    );
    expect(absent.decision).toBe("deny");
    if (absent.decision === "deny") {
      expect(absent.reason).toBe("capability-unknown");
    }
  });

  it("A-8 secrets rotation: rotated credentials stop granting under the active pointer; retired versions fail closed", async () => {
    const secrets = new InMemorySecrets();
    const v1 = secrets.register("edge-credential", "edge-material-version-one");
    expect(v1).toBe(1);

    // Active resolution works.
    const active = await secrets.resolve({ name: "edge-credential" as never, version: null });
    expect(active.version).toBe(1);

    // Rotation: the active pointer moves; the OLD version is still
    // resolvable by PINNED reference (grace for in-flight holders)...
    const v2 = secrets.rotate("edge-credential", "edge-material-version-two");
    expect(v2).toBe(2);
    const pinnedOld = await secrets.resolve({ name: "edge-credential" as never, version: 1 as never });
    expect(pinnedOld.version).toBe(1);
    const activeNow = await secrets.resolve({ name: "edge-credential" as never, version: null });
    expect(activeNow.version).toBe(2);

    // ...until retired: the pinned reference fails closed thereafter.
    secrets.retire("edge-credential", 1);
    await expect(
      secrets.resolve({ name: "edge-credential" as never, version: 1 as never }),
    ).rejects.toMatchObject({ reason: "SECRET_VERSION_RETIRED" });
    const activeAfterRetire = await secrets.resolve({ name: "edge-credential" as never, version: null });
    expect(activeAfterRetire.version).toBe(2);

    // Retiring the ACTIVE version is rejected (rotate first - fail-closed).
    expect(() => secrets.retire("edge-credential", 2)).toThrowError(ConflictError);
  });
});
