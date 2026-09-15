/**
 * Deterministic fixture builders for Wave-0 @roamlink/contracts types
 * (RL-040 platform scaffolding).
 *
 * Every builder validates through the real contracts parsers, so a fixture is
 * valid BY CONSTRUCTION (a broken default fails fast at the parser, not in an
 * unrelated test). Fixtures are deterministic: the same seed produces the
 * same value across runs and machines.
 */
import {
  CommandEnvelope,
  addMilliseconds,
  makeFreshness,
  parseActorId,
  parseCanonicalUuidAs,
  parseCorrelationId,
  parseIdempotencyKey,
  parseUtcInstant,
  tenantIdFromOrganization,
  tenantIdFromUser,
  type ActorId,
  type Branded,
  type CommandEnvelopeInput,
  type CommandEnvelopePlain,
  type CommandId,
  type CorrelationId,
  type Freshness,
  type IdempotencyKey,
  type OrganizationId,
  type TenantId,
  type UtcInstant,
  type UserId,
} from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "../ids.js";

/** The fixed base instant used by all time fixtures (UTC, ms precision). */
export const FIXED_INSTANT_ISO = "2026-01-15T08:30:00.000Z";

/**
 * Deterministic instant: the fixed base instant shifted by
 * `offsetMilliseconds` (negative allowed). `fixtureUtcInstant()` is the base
 * itself.
 */
export function fixtureUtcInstant(offsetMilliseconds = 0): UtcInstant {
  const base = parseUtcInstant(FIXED_INSTANT_ISO);
  if (!Number.isInteger(offsetMilliseconds)) {
    throw new Error("fixtureUtcInstant: offsetMilliseconds must be an integer");
  }
  return addMilliseconds(base, offsetMilliseconds);
}

function uuidFixture<T extends Branded<string>>(seed: number, label: string): T {
  return parseCanonicalUuidAs<T>(deterministicUuidFromSeed(seed), label);
}

/** Deterministic `UserId` (seed-varied, canonical UUID). */
export function fixtureUserId(seed = 1): UserId {
  return uuidFixture<UserId>(seed, "UserId");
}

/** Deterministic `OrganizationId` (seed-varied, canonical UUID). */
export function fixtureOrganizationId(seed = 1): OrganizationId {
  return uuidFixture<OrganizationId>(seed, "OrganizationId");
}

/** Deterministic `CommandId` (seed-varied, canonical UUID). */
export function fixtureCommandId(seed = 1): CommandId {
  return uuidFixture<CommandId>(seed, "CommandId");
}

/** Deterministic `CorrelationId` (`corr-<seed>`, foreign-ref shaped). */
export function fixtureCorrelationId(seed = 1): CorrelationId {
  return parseCorrelationId(`corr-${seed}`);
}

/** Deterministic `IdempotencyKey` (`idem-<seed>`, foreign-ref shaped). */
export function fixtureIdempotencyKey(seed = 1): IdempotencyKey {
  return parseIdempotencyKey(`idem-${seed}`);
}

/** Deterministic `ActorId` (`actor-<seed>`, foreign-ref shaped). */
export function fixtureActorId(seed = 1): ActorId {
  return parseActorId(`actor-${seed}`);
}

/** Options for {@link fixtureTenantId}. */
export interface FixtureTenantIdOptions {
  /** Tenant scope; defaults to `organization`. */
  readonly scope?: "organization" | "user";
  /** Varies the embedded UUID; defaults to 1. */
  readonly seed?: number;
}

/** Deterministic `TenantId` (`org:<uuid>` or `usr:<uuid>`). */
export function fixtureTenantId(options?: FixtureTenantIdOptions): TenantId {
  const scope = options?.scope ?? "organization";
  const seed = options?.seed ?? 1;
  return scope === "organization"
    ? tenantIdFromOrganization(fixtureOrganizationId(seed))
    : tenantIdFromUser(fixtureUserId(seed));
}

/** Overrides for {@link fixtureFreshness}. */
export interface FixtureFreshnessOverrides {
  readonly observedAt?: UtcInstant;
  readonly receivedAt?: UtcInstant;
  /** Defaults to `observedAt + 60s`; pass `null` for "no freshness guarantee". */
  readonly freshUntil?: UtcInstant | null;
  /** Evaluation instant for the recorded freshness state; defaults to `observedAt`. */
  readonly at?: UtcInstant;
}

/**
 * Deterministic, FRESH-by-default freshness record built with the real Wave-0
 * `makeFreshness` (so the recorded `freshnessState` is honestly evaluated,
 * not asserted).
 */
export function fixtureFreshness(overrides?: FixtureFreshnessOverrides): Freshness {
  const observedAt = overrides?.observedAt ?? fixtureUtcInstant();
  const receivedAt = overrides?.receivedAt ?? observedAt;
  const at = overrides?.at ?? observedAt;
  const freshUntil =
    overrides?.freshUntil !== undefined ? overrides.freshUntil : addMilliseconds(observedAt, 60_000);
  return makeFreshness({ observedAt, receivedAt, freshUntil }, at);
}

/** Overrides for {@link fixtureCommandEnvelope} (raw strings; validated by the envelope). */
export interface FixtureCommandEnvelopeOverrides {
  /** Varies all defaulted ids; defaults to 1. */
  readonly seed?: number;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly actorId?: string;
  readonly tenantId?: string;
  readonly intentVersion?: number;
  readonly orderVersion?: number;
  readonly createdAt?: string;
  /** 1-based attempt counter; defaults to 1. */
  readonly attempt?: number;
}

/**
 * Deterministic, fully valid `CommandEnvelope`. Every default passes the
 * envelope's own constructor validation; overrides are validated by the same
 * constructor (invalid overrides throw `ValidationError`).
 */
export function fixtureCommandEnvelope(overrides?: FixtureCommandEnvelopeOverrides): CommandEnvelope {
  const seed = overrides?.seed ?? 1;
  const input: CommandEnvelopeInput = {
    commandId: overrides?.commandId ?? deterministicUuidFromSeed(seed),
    correlationId: overrides?.correlationId ?? `corr-${seed}`,
    idempotencyKey: overrides?.idempotencyKey ?? `idem-${seed}`,
    actorId: overrides?.actorId ?? `actor-${seed}`,
    tenantId: overrides?.tenantId ?? fixtureTenantId({ seed }),
    createdAt: overrides?.createdAt ?? fixtureUtcInstant(),
    retry: { attempt: overrides?.attempt ?? 1 },
    ...(overrides?.intentVersion !== undefined ? { intentVersion: overrides.intentVersion } : {}),
    ...(overrides?.orderVersion !== undefined ? { orderVersion: overrides.orderVersion } : {}),
  };
  return new CommandEnvelope(input);
}

/** Deterministic plain (serialized) command envelope. */
export function fixtureCommandEnvelopePlain(
  overrides?: FixtureCommandEnvelopeOverrides,
): CommandEnvelopePlain {
  return fixtureCommandEnvelope(overrides).toPlain();
}
