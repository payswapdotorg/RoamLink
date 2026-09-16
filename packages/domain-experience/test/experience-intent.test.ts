/**
 * RL-011 ExperienceIntent + ExperienceIntentVersion tests: the validated
 * state machine, the immutable version chain with supersession links,
 * deterministic payload digests, and optimistic-concurrency revisions.
 */
import { describe, expect, it } from "vitest";
import { ValidationError, parseUtcInstant } from "@roamlink/contracts";
import { deterministicUuidFromSeed } from "@roamlink/testkit";

import {
  ExperienceIntent,
  ExperienceIntentVersion,
  isExperienceIntentStatus,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const at = (iso: string) => parseUtcInstant(iso);
const INTENT_ID = deterministicUuidFromSeed(30);
const OWNER = deterministicUuidFromSeed(2);
const V1 = deterministicUuidFromSeed(31);
const V2 = deterministicUuidFromSeed(32);
const TENANT = `usr:${OWNER}`;

function payloadFixture(overrides?: Record<string, unknown>) {
  return {
    travelWindow: { start: "2026-02-01T00:00:00.000Z", end: "2026-02-14T00:00:00.000Z" },
    usageProfile: "travel_international",
    preferences: {
      reliability: "high",
      latency: "interactive",
      costSensitivity: "medium",
      privacySensitivity: "high",
      preferredAccessClasses: ["trusted_wifi"],
    },
    hardConstraints: {
      requireEncryptedTransport: true,
      forbidRoaming: false,
      forbidOpenWifi: true,
    },
    ...overrides,
  };
}

function intentInput(overrides?: Record<string, unknown>) {
  return {
    intentId: INTENT_ID,
    ownerUserId: OWNER,
    status: "draft",
    currentVersionId: V1,
    currentVersionNumber: 1,
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
    ...overrides,
  };
}

function versionInput(overrides?: Record<string, unknown>) {
  return {
    tenantId: TENANT,
    intentVersionId: V1,
    intentId: INTENT_ID,
    versionNumber: 1,
    payload: payloadFixture(),
    createdAt: T0,
    ...overrides,
  };
}

describe("ExperienceIntentVersion (immutable)", () => {
  it("version 1 starts the chain; later versions must name their predecessor", () => {
    expect(() => new ExperienceIntentVersion(versionInput())).not.toThrow();
    expect(
      () => new ExperienceIntentVersion(versionInput({ supersedes: deterministicUuidFromSeed(99) })),
    ).toThrowError(/supersedes nothing/);
    expect(
      () =>
        new ExperienceIntentVersion(
          versionInput({ intentVersionId: V2, versionNumber: 2 }),
        ),
    ).toThrowError(/must name the version they supersede/);
    expect(
      () =>
        new ExperienceIntentVersion(
          versionInput({ intentVersionId: V2, versionNumber: 2, supersedes: V1 }),
        ),
    ).not.toThrow();
  });

  it("payload digests are deterministic and differ when the payload differs", () => {
    const a = new ExperienceIntentVersion(versionInput());
    const b = new ExperienceIntentVersion(versionInput());
    const c = new ExperienceIntentVersion(
      versionInput({
        payload: payloadFixture({
          preferences: { ...payloadFixture().preferences, reliability: "mission_critical" },
        }),
      }),
    );
    expect(a.payloadDigest).toBe(b.payloadDigest);
    expect(a.payloadDigest).not.toBe(c.payloadDigest);
    expect(a.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records are frozen and rationale is bounded printable text", () => {
    const version = new ExperienceIntentVersion(
      versionInput({ rationale: "Prefer trusted Wi-Fi for the Ghana trip" }),
    );
    expect(Object.isFrozen(version)).toBe(true);
    expect(version.rationale).toBe("Prefer trusted Wi-Fi for the Ghana trip");
    expect(
      () => new ExperienceIntentVersion(versionInput({ rationale: "x".repeat(281) })),
    ).toThrowError(ValidationError);
    expect(() => new ExperienceIntentVersion(versionInput({ extra: 1 }))).toThrowError(/unknown field/);
  });
});

describe("ExperienceIntent state machine", () => {
  it("draft -> active -> superseded -> archived with validated transitions", () => {
    let intent = new ExperienceIntent(intentInput());
    expect(intent.status).toBe("draft");
    expect(intent.tenantId).toBe(TENANT);
    intent = intent.activate(at("2026-01-15T09:00:00.000Z"));
    expect(intent.status).toBe("active");
    expect(intent.revision).toBe(2);
    intent = intent.supersede(deterministicUuidFromSeed(40), at("2026-01-16T09:00:00.000Z"));
    expect(intent.status).toBe("superseded");
    expect(intent.supersededBy).toBe(deterministicUuidFromSeed(40));
    intent = intent.archive(at("2026-01-17T09:00:00.000Z"));
    expect(intent.status).toBe("archived");
    expect(intent.revision).toBe(4);
  });

  it("draft -> canceled and draft -> archived are valid; terminal states refuse everything", () => {
    const canceled = new ExperienceIntent(intentInput()).cancel(at("2026-01-15T09:00:00.000Z"));
    expect(canceled.status).toBe("canceled");
    expect(() => canceled.archive(at("2026-01-15T10:00:00.000Z"))).toThrowError(/terminal/);
    expect(() => canceled.activate(at("2026-01-15T10:00:00.000Z"))).toThrowError(ValidationError);
    const archived = new ExperienceIntent(intentInput()).archive(at("2026-01-15T09:00:00.000Z"));
    expect(archived.status).toBe("archived");
  });

  it("only ACTIVE intents can supersede; superseded intents must name a successor", () => {
    const draft = new ExperienceIntent(intentInput());
    expect(() => draft.supersede(deterministicUuidFromSeed(41), at("2026-01-15T09:00:00.000Z"))).toThrowError(
      /only an active intent/,
    );
    expect(
      () => new ExperienceIntent(intentInput({ status: "superseded" })),
    ).toThrowError(/must name its successor/);
    expect(
      () =>
        new ExperienceIntent(
          intentInput({ status: "superseded", supersededBy: INTENT_ID }),
        ),
    ).toThrowError(/cannot supersede itself/);
  });

  it("status vocabulary is closed", () => {
    expect(() => new ExperienceIntent(intentInput({ status: "deleted" }))).toThrowError(ValidationError);
    expect(isExperienceIntentStatus("draft")).toBe(true);
    expect(isExperienceIntentStatus("deleted")).toBe(false);
  });
});

describe("version chain via appendVersion", () => {
  it("appends v2 supersedes v1, bumping header revision and version pointer", () => {
    const intent = new ExperienceIntent(intentInput());
    const appended = intent.appendVersion({
      intentVersionId: V2,
      payload: payloadFixture({ usageProfile: "work_critical" }),
      rationale: "Switched to work profile",
      at: at("2026-01-15T10:00:00.000Z"),
    });
    expect(appended.version.versionNumber).toBe(2);
    expect(appended.version.supersedes).toBe(V1);
    expect(appended.intent.currentVersionId).toBe(V2);
    expect(appended.intent.currentVersionNumber).toBe(2);
    expect(appended.intent.revision).toBe(2);
    expect(intent.currentVersionNumber).toBe(1); // original untouched
  });

  it("frozen intents (superseded/archived/canceled) accept no new versions", () => {
    for (const status of ["superseded", "archived", "canceled"] as const) {
      const intent = new ExperienceIntent(
        intentInput({
          status,
          ...(status === "superseded" ? { supersededBy: deterministicUuidFromSeed(42) } : {}),
        }),
      );
      expect(() =>
        intent.appendVersion({ intentVersionId: V2, payload: payloadFixture(), at: at("2026-01-15T10:00:00.000Z") }),
      ).toThrowError(/frozen/);
    }
  });

  it("records round-trip through toRecord/fromRecord with optional fields intact", () => {
    const intent = new ExperienceIntent(
      intentInput({
        deviceId: deterministicUuidFromSeed(50),
        status: "superseded",
        supersededBy: deterministicUuidFromSeed(43),
        revision: 3,
      }),
    );
    const roundTripped = ExperienceIntent.fromRecord(intent.toRecord());
    expect(roundTripped.toRecord()).toEqual(intent.toRecord());
    expect(Object.isFrozen(roundTripped)).toBe(true);
  });
});
