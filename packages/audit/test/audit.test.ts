/**
 * RL-051 tests: audit events - taxonomy validation, chain construction,
 * immutability, digest-chain tamper detection (on JSON round-trips),
 * correlation queries, and the structural adapters.
 */
import { describe, expect, it } from "vitest";

import {
  AuditEvent,
  InMemoryAuditLog,
  auditEventFromAuthorityDecision,
  auditEventFromSecretAccess,
  buildAuditEvent,
  verifyAuditChain,
} from "../src/index.js";
import type { AuditEventInput } from "../src/index.js";
import { DeterministicUuidGenerator, fixtureTenantId, fixtureUtcInstant } from "@roamlink/testkit";
import { parseActorId, parseCorrelationId } from "@roamlink/contracts";

function authEvent(overrides?: Partial<AuditEventInput>): AuditEventInput {
  return {
    category: "auth",
    action: "session.create",
    outcome: "allowed",
    actorId: "actor-1",
    tenantId: fixtureTenantId({ seed: 1 }),
    correlationId: "corr-1",
    occurredAt: fixtureUtcInstant(),
    ...overrides,
  };
}

describe("AuditEvent validation", () => {
  it("builds a genesis event with null prevDigest and a valid digest", () => {
    const event = buildAuditEvent({
      eventId: "00000000-0000-4000-8000-000000000001",
      body: authEvent(),
      sequence: 1,
      prevDigest: null,
    });
    expect(event.sequence).toBe(1);
    expect(event.prevDigest).toBeNull();
    expect(event.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.toPlain())).toBe(true);
  });

  it("rejects categories, outcomes, actions and details outside the closed vocabularies", () => {
    const base = { eventId: "00000000-0000-4000-8000-000000000001", sequence: 1, prevDigest: null };
    expect(() => buildAuditEvent({ ...base, body: authEvent({ category: "fun" }) })).toThrow(
      /closed audit taxonomy/,
    );
    expect(() => buildAuditEvent({ ...base, body: authEvent({ outcome: "maybe" }) })).toThrow(
      /allowed, denied, degraded, failed/,
    );
    expect(() => buildAuditEvent({ ...base, body: authEvent({ action: "Bad Action" }) })).toThrow(
      /safe label/,
    );
    expect(() => buildAuditEvent({ ...base, body: authEvent({ detail: "x".repeat(257) }) })).toThrow(
      /detail/,
    );
    expect(() => buildAuditEvent({ ...base, body: authEvent({ occurredAt: "2026-01-15T08:30:00" }) })).toThrow(
      /occurredAt/,
    );
    expect(() => buildAuditEvent({ ...base, body: authEvent({ extra: 1 } as never) })).toThrow(
      /unknown field/,
    );
  });

  it("requires correlationId and validates tenant/command ids", () => {
    const base = { eventId: "00000000-0000-4000-8000-000000000001", sequence: 1, prevDigest: null };
    expect(() => buildAuditEvent({ ...base, body: authEvent({ correlationId: "" }) })).toThrow(
      /correlationId/,
    );
    expect(() => buildAuditEvent({ ...base, body: authEvent({ tenantId: "nope" }) })).toThrow(
      /tenantId/,
    );
    expect(() =>
      buildAuditEvent({
        ...base,
        body: authEvent({ commandId: "not-a-uuid" }),
      }),
    ).toThrow(/commandId/);
    // tenant-less (pre-auth) events are legal
    const { tenantId: _drop, ...withoutTenant } = authEvent();
    expect(() => buildAuditEvent({ ...base, body: withoutTenant })).not.toThrow();
  });

  it("round-trips through fromPlain and rejects tampered digests", async () => {
    const ids = new DeterministicUuidGenerator(1);
    const log = new InMemoryAuditLog({ eventIdGenerator: () => ids.next() });
    const event = await log.append(authEvent());
    const restored = AuditEvent.fromPlain(JSON.parse(JSON.stringify(event.toPlain())));
    expect(restored.toPlain()).toEqual(event.toPlain());

    const tampered = JSON.parse(JSON.stringify(event.toPlain())) as Record<string, unknown>;
    tampered["outcome"] = "denied";
    expect(() => AuditEvent.fromPlain(tampered)).toThrow(/recomputed digest/);
  });
});

describe("InMemoryAuditLog (append-only stream)", () => {
  async function filledLog(): Promise<InMemoryAuditLog> {
    const ids = new DeterministicUuidGenerator(1);
    const log = new InMemoryAuditLog({ eventIdGenerator: () => ids.next() });
    await log.append(authEvent({ correlationId: "corr-1", occurredAt: fixtureUtcInstant(0) }));
    await log.append(
      authEvent({
        category: "secret-access",
        action: "secret.resolve",
        outcome: "denied",
        correlationId: "corr-2",
        occurredAt: fixtureUtcInstant(1_000),
      }),
    );
    await log.append(
      authEvent({
        category: "admin-override",
        action: "support.impersonate",
        outcome: "allowed",
        actorId: "actor-2",
        correlationId: "corr-1",
        occurredAt: fixtureUtcInstant(2_000),
      }),
    );
    return log;
  }

  it("chains sequences and prevDigests correctly", async () => {
    const log = await filledLog();
    const events = await log.events();
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.prevDigest).toBe(events[0]?.digest);
    expect(events[2]?.prevDigest).toBe(events[1]?.digest);
    expect(events[0]?.prevDigest).toBeNull();
  });

  it("verifies cleanly on the untouched chain", async () => {
    const log = await filledLog();
    await expect(log.verify()).resolves.toEqual({ ok: true, verifiedCount: 3 });
  });

  it("has NO mutation API and records are deeply frozen", async () => {
    const log = await filledLog();
    const auditLog = log as unknown as Record<string, unknown>;
    for (const forbidden of ["update", "delete", "remove", "truncate", "clear", "rewrite", "edit"]) {
      expect(auditLog[forbidden], `audit log must not expose '${forbidden}'`).toBeUndefined();
    }
    const event = (await log.events())[0];
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as unknown as { outcome: string }).outcome = "denied";
    }).toThrow();
  });

  it("queries by correlation id, actor, tenant, category and time range", async () => {
    const log = await filledLog();
    const byCorrelation = await log.query({ correlationId: parseCorrelationId("corr-1") });
    expect(byCorrelation.map((e) => e.sequence)).toEqual([1, 3]);
    const byActor = await log.query({ actorId: parseActorId("actor-2") });
    expect(byActor.map((e) => e.sequence)).toEqual([3]);
    const byCategory = await log.query({ category: "secret-access" });
    expect(byCategory.map((e) => e.sequence)).toEqual([2]);
    const byTime = await log.query({ from: fixtureUtcInstant(500), to: fixtureUtcInstant(1_500) });
    expect(byTime.map((e) => e.sequence)).toEqual([2]);
    const byTenant = await log.query({ tenantId: fixtureTenantId({ seed: 1 }) });
    expect(byTime.length).toBeGreaterThan(0);
    expect(byTenant.length).toBe(3);
    await expect(log.query({ category: "bogus" })).rejects.toThrow(/closed audit taxonomy/);
  });
});

describe("digest-chain tamper detection", () => {
  async function plainChain(): Promise<Record<string, unknown>[]> {
    const ids = new DeterministicUuidGenerator(1);
    const log = new InMemoryAuditLog({ eventIdGenerator: () => ids.next() });
    for (let i = 0; i < 5; i += 1) {
      await log.append(
        authEvent({ correlationId: `corr-${i}`, occurredAt: fixtureUtcInstant(i * 1_000) }),
      );
    }
    return (await log.events()).map((e) => JSON.parse(JSON.stringify(e.toPlain())));
  }

  it("accepts a JSON round-tripped intact chain", async () => {
    expect(verifyAuditChain(await plainChain())).toEqual({ ok: true, verifiedCount: 5 });
  });

  it("detects a mutated body field at the first broken sequence", async () => {
    const chain = await plainChain();
    (chain[2] as Record<string, unknown>)["actorId"] = "attacker";
    expect(verifyAuditChain(chain)).toEqual({
      ok: false,
      reason: "digest-mismatch",
      firstBrokenSequence: 3,
    });
  });

  it("detects a re-forged digest (chain breaks at the successor)", async () => {
    const chain = await plainChain();
    const victim = chain[2] as Record<string, unknown>;
    victim["outcome"] = "denied";
    // attacker recomputes the victim's digest so IT verifies - but the
    // successor's prevDigest linkage now breaks.
    const { digest: _omit, ...body } = victim;
    const { sha256Hex, canonicalizeJson } = await import("@roamlink/contracts");
    victim["digest"] = sha256Hex(
      canonicalizeJson({
        eventId: body["eventId"],
        sequence: body["sequence"],
        category: body["category"],
        action: body["action"],
        outcome: body["outcome"],
        actorId: body["actorId"],
        tenantId: body["tenantId"],
        correlationId: body["correlationId"],
        occurredAt: body["occurredAt"],
        prevDigest: body["prevDigest"],
      }),
    );
    expect(verifyAuditChain(chain)).toEqual({
      ok: false,
      reason: "chain-broken",
      firstBrokenSequence: 4,
    });
  });

  it("detects reordering, splicing and extra-field tampering", async () => {
    const chain = await plainChain();
    const reordered = [chain[1], chain[0], ...chain.slice(2)];
    expect(verifyAuditChain(reordered)).toMatchObject({ ok: false });

    const spliced = [...chain.slice(0, 2), ...chain.slice(3)];
    expect(verifyAuditChain(spliced)).toMatchObject({ ok: false, reason: "sequence-invalid" });

    const extra = [...chain];
    (extra[4] as Record<string, unknown>)["sneaky"] = true;
    expect(verifyAuditChain(extra)).toMatchObject({ ok: false, firstBrokenSequence: 5 });

    const missing = chain.filter((e) => (e as Record<string, unknown>)["digest"] !== undefined);
    expect(verifyAuditChain([missing[0]])).toEqual({ ok: true, verifiedCount: 1 });
    expect(verifyAuditChain([])).toEqual({ ok: true, verifiedCount: 0 });
  });
});

describe("structural adapters", () => {
  it("maps secret-access notifications to audit inputs (value-free)", () => {
    const input = auditEventFromSecretAccess({
      notification: {
        ref: { name: "ADCOS_CLIENT_SECRET", version: null },
        resolvedVersion: 2,
        outcome: "resolved",
        at: fixtureUtcInstant(),
      },
      actorId: "actor-1",
      correlationId: "corr-9",
    });
    expect(input.category).toBe("secret-access");
    expect(input.action).toBe("secret.resolve");
    expect(input.outcome).toBe("allowed");
    expect(input.target).toBe("ADCOS_CLIENT_SECRET");
    expect(input.detail).toContain("requested active");
    expect(input.detail).toContain("resolved v2");
    expect(JSON.stringify(input)).not.toContain("secret-value");
  });

  it("maps denied secret access and authority gate decisions", async () => {
    const denied = auditEventFromSecretAccess({
      notification: {
        ref: { name: "restricted", version: 1 },
        resolvedVersion: null,
        outcome: "forbidden",
        at: fixtureUtcInstant(),
      },
      actorId: "actor-1",
      correlationId: "corr-9",
    });
    expect(denied.outcome).toBe("denied");

    const gate = auditEventFromAuthorityDecision({
      decision: { decision: "degrade", capability: "wifi_control", reason: "capability-requires-permission" },
      actorId: "actor-1",
      correlationId: "corr-10",
      occurredAt: fixtureUtcInstant(),
    });
    expect(gate.category).toBe("authority-decision");
    expect(gate.action).toBe("capability.wifi-control.gate");
    expect(gate.outcome).toBe("degraded");
    expect(gate.detail).toBe("reason capability-requires-permission");

    // both adapt into appendable events
    const log = new InMemoryAuditLog();
    await log.append(denied);
    await log.append(gate);
    await expect(log.verify()).resolves.toEqual({ ok: true, verifiedCount: 2 });
  });
});
