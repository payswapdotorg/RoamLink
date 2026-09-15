/**
 * Shared deterministic builders for edge contract tests. Test-only; not part
 * of the package surface. Uses @roamlink/testkit fixtures where possible and
 * falls back to minimal local builders for edge-specific shapes.
 */
import {
  fixtureCommandEnvelope,
  fixtureFreshness,
  fixtureTenantId,
  fixtureUtcInstant,
} from "@roamlink/testkit";
import type {
  EdgeCapabilityEntry,
  EdgeCapabilityName,
  EdgeCapabilitySnapshotInput,
  EdgePlatformFamily,
} from "../src/index.js";
import { edgeCapabilitiesInScope } from "../src/index.js";

export type { EdgeCapabilitySnapshotInput };

export const OBSERVED_AT = fixtureUtcInstant();
export const FRESH_UNTIL = fixtureUtcInstant(60_000);

export interface EntryOverrides {
  readonly status?: EdgeCapabilityEntry["status"];
  readonly evidenceClass?: EdgeCapabilityEntry["evidenceClass"];
  readonly observedAt?: EdgeCapabilityEntry["observedAt"];
  readonly evidence?: EdgeCapabilityEntry["evidence"];
}

/** A valid, evidenced entry defaulting to available + OBSERVED + probe. */
export function entry(overrides?: EntryOverrides): Record<string, unknown> {
  return {
    status: overrides?.status ?? "available",
    evidenceClass: overrides?.evidenceClass ?? "OBSERVED",
    observedAt: overrides?.observedAt ?? OBSERVED_AT,
    evidence:
      overrides?.evidence ?? { kind: "platform-api-probe", source: "TestProbe.framework" },
  };
}

/** An unknown, never-probed entry (honest absence of evidence). */
export function unknownEntry(): Record<string, unknown> {
  return {
    status: "unknown",
    evidenceClass: "UNKNOWN",
    observedAt: OBSERVED_AT,
    evidence: { kind: "none" },
  };
}

export interface SnapshotOverrides {
  readonly snapshotId?: string;
  readonly family?: EdgePlatformFamily;
  readonly sequence?: number;
  readonly deviceRef?: string;
  readonly contractVersion?: string;
  readonly observedAt?: string;
  readonly freshUntil?: string | null;
  readonly capabilities?: Record<string, Record<string, unknown>>;
  readonly dropCapabilities?: readonly EdgeCapabilityName[];
}

/**
 * A valid snapshot input covering exactly the in-scope capabilities for the
 * family (default `ios`, i.e. the full vocabulary), each defaulting to an
 * evidenced `available` entry. Overrides replace entries per-name; names in
 * `dropCapabilities` are removed (to test totality rejection).
 */
export function snapshotInput(overrides?: SnapshotOverrides): EdgeCapabilitySnapshotInput {
  const family = overrides?.family ?? "ios";
  const drop = new Set<string>(overrides?.dropCapabilities ?? []);
  const capabilities: Record<string, Record<string, unknown>> = {};
  for (const name of edgeCapabilitiesInScope(family)) {
    if (drop.has(name)) continue;
    const custom = overrides?.capabilities?.[name];
    capabilities[name] = custom ?? entry();
  }
  for (const [name, value] of Object.entries(overrides?.capabilities ?? {})) {
    capabilities[name] = value;
  }
  return {
    snapshotId: overrides?.snapshotId ?? "00000000-0000-4000-8000-000000000001",
    contractVersion: overrides?.contractVersion ?? "0.1",
    sequence: overrides?.sequence ?? 1,
    deviceRef: overrides?.deviceRef ?? "device-enrollment-ref-1",
    platform: { family, platformVersion: "18.2" },
    observedAt: overrides?.observedAt ?? OBSERVED_AT,
    freshUntil: overrides?.freshUntil === undefined ? FRESH_UNTIL : overrides.freshUntil,
    capabilities,
  };
}

/** Deterministic fixture command envelope for action contracts. */
export function commandFixture(): ReturnType<typeof fixtureCommandEnvelope> {
  return fixtureCommandEnvelope({ tenantId: fixtureTenantId({ scope: "user", seed: 3 }) });
}

/** Deterministic fixture freshness for sync records. */
export function freshnessFixture(): ReturnType<typeof fixtureFreshness> {
  return fixtureFreshness();
}
