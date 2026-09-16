/**
 * Shared fixtures for the intent-compiler test suite: a valid intent +
 * version record pair built through the real domain constructors, plus
 * deterministic compile options.
 */
import { tenantIdFromUser, parseUserId, type UserId } from "@roamlink/contracts";
import { DeterministicUuidGenerator } from "@roamlink/testkit";
import {
  ExperienceIntent,
  ExperienceIntentVersion,
  type ExperienceIntentRecord,
  type ExperienceIntentVersionRecord,
} from "@roamlink/domain-experience";

export const OWNER: UserId = parseUserId("00000000-0000-4000-8000-000000000002");
export const TENANT = tenantIdFromUser(OWNER);
export const T0 = "2026-01-15T08:30:00.000Z";

export function payloadFixture(overrides?: Record<string, unknown>) {
  return {
    travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
    usageProfile: "travel_international",
    preferences: {
      reliability: "high",
      latency: "interactive",
      costSensitivity: "medium",
      privacySensitivity: "high",
      preferredAccessClasses: ["trusted_wifi", "open_wifi", "roaming_cellular"],
    },
    hardConstraints: {
      requireEncryptedTransport: true,
      forbidRoaming: false,
      forbidOpenWifi: true,
    },
    ...overrides,
  };
}

export function intentVersionPair(
  overrides?: {
    payload?: Record<string, unknown>;
    status?: string;
    versionNumber?: number;
  },
): { intent: ExperienceIntentRecord; version: ExperienceIntentVersionRecord } {
  const ids = new DeterministicUuidGenerator(11);
  const intentVersionId = "00000000-0000-4000-8000-0000000000a1";
  const intentId = "00000000-0000-4000-8000-0000000000b2";
  void ids;
  const version = new ExperienceIntentVersion({
    tenantId: TENANT,
    intentVersionId,
    intentId,
    versionNumber: overrides?.versionNumber ?? 1,
    payload: payloadFixture(overrides?.payload),
    createdAt: T0,
  });
  const status = (overrides?.status ?? "active") as ExperienceIntentRecord["status"];
  const intent = new ExperienceIntent({
    intentId,
    ownerUserId: OWNER,
    status,
    ...(status === "superseded"
      ? { supersededBy: "00000000-0000-4000-8000-0000000000c9" }
      : {}),
    currentVersionId: version.intentVersionId,
    currentVersionNumber: version.versionNumber,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  });
  return { intent: intent.toRecord(), version: version.toRecord() };
}

export function compileOptionsFixture(overrides?: Record<string, unknown>) {
  return {
    at: "2026-01-20T09:00:00.000Z",
    commandId: "00000000-0000-4000-8000-0000000000c3",
    ...overrides,
  };
}
