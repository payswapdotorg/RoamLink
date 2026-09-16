/**
 * Shared deterministic builders for the RL-043 edge-actions tests. Test-only;
 * not part of the package surface. Mirrors the edge package's test helpers
 * and uses @roamlink/testkit fixtures.
 */
import {
  fixtureFreshness,
  fixtureTenantId,
  fixtureUtcInstant,
} from "@roamlink/testkit";
import {
  DeviceActionRequest,
  EdgeCapabilitySnapshot,
  EdgeOfflineOutbox,
  InMemoryEdgeOutboxStore,
  createAesGcmEdgePayloadCipher,
  edgeCapabilitiesInScope,
  type DeviceActionRequestInput,
  type EdgeCapabilityName,
  type EdgeCapabilitySnapshotInput,
  type EdgePlatformFamily,
} from "@roamlink/edge";

import { InMemoryPlatformActionExecutor } from "../src/index.js";

export const T0 = fixtureUtcInstant();
export const FRESH_UNTIL = fixtureUtcInstant(60_000);
export const KEY_ID = "edge-actions-test-key";
const KEY = new TextEncoder().encode("0123456789abcdef0123456789abcdef"); // 32 bytes

export interface EntryOverrides {
  readonly status?: "available" | "unavailable" | "requires-permission" | "unknown";
  readonly evidenceClass?: string;
  readonly observedAt?: string;
  readonly evidence?: Record<string, unknown>;
}

/** An evidenced `available` entry by default (OBSERVED + platform-api-probe). */
export function entry(overrides?: EntryOverrides): Record<string, unknown> {
  return {
    status: overrides?.status ?? "available",
    evidenceClass: overrides?.evidenceClass ?? "OBSERVED",
    observedAt: overrides?.observedAt ?? T0,
    evidence:
      overrides?.evidence ?? { kind: "platform-api-probe", source: "TestProbe.framework" },
  };
}

export interface SnapshotOverrides {
  readonly family?: EdgePlatformFamily;
  readonly observedAt?: string;
  readonly freshUntil?: string | null;
  readonly capabilities?: Record<string, Record<string, unknown>>;
}

/** A valid snapshot input for the family, every in-scope capability available. */
export function snapshotInput(overrides?: SnapshotOverrides): EdgeCapabilitySnapshotInput {
  const family = overrides?.family ?? "ios";
  const capabilities: Record<string, Record<string, unknown>> = {};
  for (const name of edgeCapabilitiesInScope(family)) {
    capabilities[name] = overrides?.capabilities?.[name] ?? entry();
  }
  for (const [name, value] of Object.entries(overrides?.capabilities ?? {})) {
    capabilities[name] = value;
  }
  return {
    snapshotId: "00000000-0000-4000-8000-000000000001",
    contractVersion: "0.1",
    sequence: 1,
    deviceRef: "device-enrollment-ref-1",
    platform: { family, platformVersion: "18.2" },
    observedAt: overrides?.observedAt ?? T0,
    freshUntil:
      overrides?.freshUntil === undefined ? FRESH_UNTIL : overrides.freshUntil,
    capabilities,
  };
}

/** A parsed snapshot for the family with per-name entry overrides. */
export function snapshot(
  overrides?: SnapshotOverrides & {
    readonly entries?: Partial<Record<EdgeCapabilityName, Record<string, unknown>>>;
  },
): EdgeCapabilitySnapshot {
  const overrideEntries = overrides?.entries as
    | Record<string, Record<string, unknown>>
    | undefined;
  return new EdgeCapabilitySnapshot(
    snapshotInput({
      ...(overrides?.family === undefined ? {} : { family: overrides.family }),
      ...(overrides?.observedAt === undefined ? {} : { observedAt: overrides.observedAt }),
      ...(overrides?.freshUntil === undefined
        ? {}
        : { freshUntil: overrides.freshUntil }),
      ...(overrideEntries === undefined ? {} : { capabilities: overrideEntries }),
    }),
  );
}

export interface RequestOverrides {
  readonly seed?: number;
  readonly capability?: string;
  readonly parameters?: Record<string, unknown>;
  readonly dedupeKey?: string;
  readonly commandId?: string;
  readonly idempotencyKey?: string;
}

/** A deterministic device action request (distinct seeds → distinct ids). */
export function actionRequest(overrides?: RequestOverrides): DeviceActionRequest {
  const seed = overrides?.seed ?? 1;
  const input: Record<string, unknown> = {
    actionId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    capabilityRequirement: { capability: overrides?.capability ?? "wifi_control" },
    parameters: overrides?.parameters ?? { networkSsid: "Guest", timeoutSeconds: 30 },
    command: {
      commandId:
        overrides?.commandId ??
        `00000000-0000-4000-8000-${(seed + 100).toString(16).padStart(12, "0")}`,
      correlationId: `corr-${seed}`,
      idempotencyKey: overrides?.idempotencyKey ?? `idem-${seed}`,
      actorId: `actor-${seed}`,
      tenantId: fixtureTenantId({ scope: "user", seed: 3 }),
      createdAt: T0,
      retry: { attempt: 1 },
    },
    dedupeKey: overrides?.dedupeKey ?? `action-${seed}`,
  };
  return DeviceActionRequest.fromPlain(input as unknown as DeviceActionRequestInput);
}

/** Deterministic outbox wiring (AES-GCM + in-memory store). */
export function outboxWiring(): { outbox: EdgeOfflineOutbox; store: InMemoryEdgeOutboxStore } {
  const store = new InMemoryEdgeOutboxStore();
  let counter = 500;
  const outbox = new EdgeOfflineOutbox({
    store,
    cipher: createAesGcmEdgePayloadCipher(async () => KEY),
    keyId: KEY_ID,
    idGenerator: () =>
      `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, "0")}`,
    defaultRetryPolicy: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1_000,
    },
  });
  return { outbox, store };
}

/** A fake executor with every capability succeeding with real evidence. */
export function succeedingExecutor(): InMemoryPlatformActionExecutor {
  return new InMemoryPlatformActionExecutor({
    capabilities: [
      { capability: "wifi_control", script: [InMemoryPlatformActionExecutor.evidencedSuccess()] },
      {
        capability: "esim_profile_install",
        script: [InMemoryPlatformActionExecutor.evidencedSuccess()],
      },
      {
        capability: "active_interface_selection",
        script: [InMemoryPlatformActionExecutor.evidencedSuccess()],
      },
    ],
  });
}

/** Deterministic enqueue context for the offline outbox. */
export function enqueueContext(): {
  deviceRef: string;
  desiredStateId: string;
  lastKnownFreshness: ReturnType<typeof fixtureFreshness>;
} {
  return {
    deviceRef: "device-enrollment-ref-1",
    desiredStateId: "00000000-0000-4000-8000-0000000000d1",
    lastKnownFreshness: fixtureFreshness(),
  };
}
