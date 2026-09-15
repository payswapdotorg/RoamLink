import { describe, expect, it } from "vitest";
import {
  CommandEnvelope,
  isActorId,
  isCanonicalUuid,
  isCorrelationId,
  isIdempotencyKey,
  isTenantId,
  isUtcInstant,
  parseFreshness,
  parseOrganizationId,
  parseUserId,
  tenantScopeOf,
} from "@roamlink/contracts";
import {
  FIXED_INSTANT_ISO,
  fixtureActorId,
  fixtureCommandEnvelope,
  fixtureCommandEnvelopePlain,
  fixtureCorrelationId,
  fixtureFreshness,
  fixtureIdempotencyKey,
  fixtureOrganizationId,
  fixtureTenantId,
  fixtureUtcInstant,
  fixtureUserId,
} from "../src/index.js";
import { deterministicUuidFromSeed } from "../src/index.js";

describe("time fixtures", () => {
  it("fixtureUtcInstant returns the fixed base instant by default", () => {
    expect(fixtureUtcInstant()).toBe(FIXED_INSTANT_ISO);
    expect(isUtcInstant(fixtureUtcInstant())).toBe(true);
  });

  it("fixtureUtcInstant shifts deterministically by whole milliseconds", () => {
    expect(fixtureUtcInstant(1_000)).toBe("2026-01-15T08:30:01.000Z");
    expect(fixtureUtcInstant(-1_000)).toBe("2026-01-15T08:29:59.000Z");
    expect(fixtureUtcInstant(60_000)).toBe("2026-01-15T08:31:00.000Z");
  });
});

describe("id fixtures", () => {
  it("produces values accepted by the Wave-0 parsers", () => {
    expect(isCanonicalUuid(fixtureUserId())).toBe(true);
    expect(isCanonicalUuid(fixtureOrganizationId())).toBe(true);
    expect(isCanonicalUuid(fixtureCommandEnvelope().commandId)).toBe(true);
    expect(isCorrelationId(fixtureCorrelationId())).toBe(true);
    expect(isIdempotencyKey(fixtureIdempotencyKey())).toBe(true);
    expect(isActorId(fixtureActorId())).toBe(true);
    expect(isTenantId(fixtureTenantId())).toBe(true);
    expect(isTenantId(fixtureTenantId({ scope: "user", seed: 3 }))).toBe(true);
  });

  it("is deterministic and seed-varied", () => {
    expect(fixtureUserId(4)).toBe(fixtureUserId(4));
    expect(fixtureUserId(4)).not.toBe(fixtureUserId(5));
    expect(parseUserId(fixtureUserId(4))).toBe(deterministicUuidFromSeed(4));
    expect(parseOrganizationId(fixtureOrganizationId(9))).toBe(deterministicUuidFromSeed(9));
  });

  it("tenant fixtures encode the scope prefix", () => {
    expect(tenantScopeOf(fixtureTenantId({ scope: "organization", seed: 2 }))).toBe("organization");
    expect(tenantScopeOf(fixtureTenantId({ scope: "user", seed: 2 }))).toBe("user");
  });
});

describe("freshness fixture", () => {
  it("is FRESH by default and honestly evaluated", () => {
    const freshness = fixtureFreshness();
    expect(freshness.freshnessState).toBe("FRESH");
    expect(freshness.observedAt).toBe(fixtureUtcInstant());
    expect(freshness.freshUntil).toBe(fixtureUtcInstant(60_000));
    // round-trips through the real Wave-0 parser
    expect(parseFreshness(JSON.parse(JSON.stringify(freshness)))).toEqual(freshness);
  });

  it("respects explicit overrides, including no freshness guarantee", () => {
    const stale = fixtureFreshness({ at: fixtureUtcInstant(120_000) });
    expect(stale.freshnessState).toBe("STALE");
    const noGuarantee = fixtureFreshness({ freshUntil: null });
    expect(noGuarantee.freshnessState).toBe("UNKNOWN");
    expect(noGuarantee.freshUntil).toBeNull();
  });
});

describe("command envelope fixture", () => {
  it("constructs a valid, frozen envelope with deterministic defaults", () => {
    const envelope = fixtureCommandEnvelope();
    expect(envelope).toBeInstanceOf(CommandEnvelope);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(envelope.correlationId).toBe("corr-1");
    expect(envelope.idempotencyKey).toBe("idem-1");
    expect(envelope.actorId).toBe("actor-1");
    expect(envelope.tenantId).toBe(fixtureTenantId({ seed: 1 }));
    expect(envelope.createdAt).toBe(fixtureUtcInstant());
    expect(envelope.retry.attempt).toBe(1);
    expect(envelope.intentVersion).toBeUndefined();
    expect(envelope.orderVersion).toBeUndefined();
  });

  it("seeds vary every defaulted identity", () => {
    const one = fixtureCommandEnvelope({ seed: 1 });
    const two = fixtureCommandEnvelope({ seed: 2 });
    expect(one.commandId).not.toBe(two.commandId);
    expect(one.correlationId).not.toBe(two.correlationId);
    expect(one.idempotencyKey).not.toBe(two.idempotencyKey);
    expect(one.tenantId).not.toBe(two.tenantId);
  });

  it("applies explicit overrides and validates them through the envelope", () => {
    const envelope = fixtureCommandEnvelope({
      correlationId: "manual-corr",
      intentVersion: 7,
      attempt: 3,
    });
    expect(envelope.correlationId).toBe("manual-corr");
    expect(envelope.intentVersion).toBe(7);
    expect(envelope.retry.attempt).toBe(3);
    expect(() => fixtureCommandEnvelope({ correlationId: "not a ref!" })).toThrowError();
    expect(() => fixtureCommandEnvelope({ attempt: 0 })).toThrowError();
  });

  it("round-trips through the plain form", () => {
    const plain = fixtureCommandEnvelopePlain({ seed: 8, orderVersion: 2 });
    const restored = CommandEnvelope.fromPlain(JSON.parse(JSON.stringify(plain)));
    expect(restored.toPlain()).toEqual(plain);
  });
});
