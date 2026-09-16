import { describe, expect, it } from "vitest";
import { ValidationError, canonicalizeJson } from "@roamlink/contracts";
import { fixtureTenantId, fixtureUserId, deterministicUuidFromSeed } from "@roamlink/testkit";
import {
  compileIntentCommand,
  deriveIntentIdempotencyKey,
  intentCommandDigest,
  normalizeIntentCommand,
  retryIntentCommand,
  type IntentCommandInput,
} from "../src/index.js";

const T0 = "2026-01-15T08:30:00.000Z";
const COMMAND_ID = deterministicUuidFromSeed(42);

function baseInput(requirements?: IntentCommandInput["requirements"]): IntentCommandInput {
  return {
    sourceIntentId: deterministicUuidFromSeed(101),
    sourceIntentVersionId: deterministicUuidFromSeed(102),
    sourceIntentVersionNumber: 3,
    actorId: "actor-9",
    tenantId: fixtureTenantId({ seed: 7 }),
    requirements:
      requirements === undefined
        ? [
            {
              dimension: "privacy",
              classification: "hard",
              statement: { transport: "encrypted" },
            },
            {
              dimension: "cost",
              classification: "soft",
              statement: { sensitivity: "high" },
            },
            {
              dimension: "reliability",
              classification: "soft",
              statement: { level: "high" },
            },
          ]
        : requirements,
    validity: { start: T0, end: "2026-01-29T08:30:00.000Z" },
    termination: { actor: "customer", onExpiry: "release" },
  };
}

describe("intent command mapping determinism (RL-031 §4)", () => {
  it("same input + same instant + same ids produce byte-identical drafts", () => {
    const a = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    const b = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    expect(a.intentDigest).toBe(b.intentDigest);
    expect(canonicalizeJson(a.request)).toBe(canonicalizeJson(b.request));
    expect(a.envelope.digest()).toBe(b.envelope.digest());
    expect(a.envelope.idempotencyKey).toBe(b.envelope.idempotencyKey);
  });

  it("input ordering never affects the digest (policy normalization)", () => {
    const ordered = baseInput();
    const shuffled = baseInput([...ordered.requirements].reverse());
    expect(intentCommandDigest(normalizeIntentCommand(ordered))).toBe(
      intentCommandDigest(normalizeIntentCommand(shuffled)),
    );

    const a = compileIntentCommand(ordered, { at: T0, commandId: COMMAND_ID });
    const b = compileIntentCommand(shuffled, { at: T0, commandId: COMMAND_ID });
    expect(a.intentDigest).toBe(b.intentDigest);
    expect(canonicalizeJson(a.request)).toBe(canonicalizeJson(b.request));
    // requirements are sorted deterministically inside the request
    const requestA = a.request as unknown as { requirements: { dimension: string }[] };
    expect(requestA.requirements.map((r) => r.dimension)).toEqual(["cost", "privacy", "reliability"]);
  });

  it("duplicate identical requirement statements are dropped", () => {
    const input = baseInput([
      { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
      { dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } },
      { dimension: "cost", classification: "soft", statement: { sensitivity: "high" } },
    ]);
    const normalized = normalizeIntentCommand(input);
    expect(normalized.requirements.length).toBe(2);
  });

  it("digest is stable across object key insertion order inside statements", () => {
    const a = baseInput([
      { dimension: "locality", classification: "soft", statement: { region: "gh", city: "accra" } },
    ]);
    const b = baseInput([
      { dimension: "locality", classification: "soft", statement: { city: "accra", region: "gh" } },
    ]);
    expect(intentCommandDigest(normalizeIntentCommand(a))).toBe(
      intentCommandDigest(normalizeIntentCommand(b)),
    );
  });

  it("different payloads produce different digests and different derived keys", () => {
    const a = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    const b = compileIntentCommand(
      baseInput([{ dimension: "cost", classification: "soft", statement: { sensitivity: "low" } }]),
      { at: T0, commandId: COMMAND_ID },
    );
    expect(a.intentDigest).not.toBe(b.intentDigest);
    expect(a.envelope.idempotencyKey).not.toBe(b.envelope.idempotencyKey);
  });

  it("the digest is a SHA-256 hex digest and the derived key is foreign-ref shaped", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    expect(draft.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.envelope.idempotencyKey).toBe(
      deriveIntentIdempotencyKey(baseInput().sourceIntentVersionId, draft.intentDigest),
    );
    expect(draft.envelope.idempotencyKey).toMatch(/^idem\.intent\./);
  });
});

describe("hard/soft constraint classification + validity window (RL-031 §4)", () => {
  it("hard requirements populate hard_constraints AND the requirements list; soft do not", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    const request = draft.request as unknown as {
      hard_constraints?: { dimension: string }[];
      requirements: { classification: string }[];
    };
    expect(request.hard_constraints).toBeDefined();
    expect(request.hard_constraints?.map((h) => h.dimension)).toEqual(["privacy"]);
    expect(request.requirements.filter((r) => r.classification === "hard")).toHaveLength(1);
    expect(request.requirements.filter((r) => r.classification === "soft")).toHaveLength(2);
  });

  it("no hard constraints -> hard_constraints omitted (exactOptionalPropertyTypes)", () => {
    const draft = compileIntentCommand(
      baseInput([{ dimension: "cost", classification: "soft", statement: { sensitivity: "high" } }]),
      { at: T0, commandId: COMMAND_ID },
    );
    expect((draft.request as unknown as Record<string, unknown>)["hard_constraints"]).toBeUndefined();
  });

  it("validity window maps into the v2 validity mapping and recorded_at is the command instant", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    const request = draft.request as unknown as Record<string, unknown>;
    expect(request["validity"]).toEqual({ start: T0, end: "2026-01-29T08:30:00.000Z" });
    expect(request["recorded_at"]).toBe(T0);
  });

  it("termination policy maps into the v2 termination mapping", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    expect((draft.request as unknown as Record<string, unknown>)["termination"]).toEqual({
      actor: "customer",
      on_expiry: "release",
    });
  });
});

describe("intent command envelope (RL-031 §5)", () => {
  it("the envelope carries the full §5 metadata with source traceability", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    const plain = draft.envelope.toPlain();
    expect(plain.commandId).toBe(COMMAND_ID);
    expect(plain.correlationId).toBe(`corr.intent.${baseInput().sourceIntentVersionId}`);
    expect(plain.idempotencyKey).toMatch(/^idem\.intent\./);
    expect(plain.actorId).toBe("actor-9");
    expect(plain.tenantId).toBe(fixtureTenantId({ seed: 7 }));
    expect(plain.intentVersion).toBe(3);
    expect(plain.createdAt).toBe(T0);
    expect(plain.retry).toEqual({ attempt: 1 });
  });

  it("retry drafts keep command id, idempotency key and payload; only retry metadata advances", () => {
    const input = baseInput();
    const draft = compileIntentCommand(input, { at: T0, commandId: COMMAND_ID });
    const retry = retryIntentCommand(draft, input, {
      reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN",
      kind: "unknown-state",
      occurredAt: T0,
    });
    expect(retry.envelope.commandId).toBe(draft.envelope.commandId);
    expect(retry.envelope.idempotencyKey).toBe(draft.envelope.idempotencyKey);
    expect(retry.envelope.createdAt).toBe(draft.envelope.createdAt);
    expect(canonicalizeJson(retry.request)).toBe(canonicalizeJson(draft.request));
    expect(retry.envelope.retry.attempt).toBe(2);
    expect(retry.envelope.retry.lastError).toEqual({
      reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN",
      kind: "unknown-state",
      occurredAt: T0,
    });
  });

  it("a retry with a CHANGED payload under the same key fails loudly (RL-LOCK-014)", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    const changed = baseInput([
      { dimension: "cost", classification: "soft", statement: { sensitivity: "low" } },
    ]);
    expect(() =>
      retryIntentCommand(draft, changed, {
        reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN",
        kind: "unknown-state",
        occurredAt: T0,
      }),
    ).toThrow(ValidationError);
  });
});

describe("intent command schema validation (RL-031 §4.1, fail-closed)", () => {
  it("rejects unknown top-level fields", () => {
    const input = { ...baseInput(), invented: true } as unknown as IntentCommandInput;
    expect(() => normalizeIntentCommand(input)).toThrow(ValidationError);
  });

  it("rejects invalid dimensions and classifications", () => {
    expect(() =>
      normalizeIntentCommand(
        baseInput([
          { dimension: "vibes", classification: "soft", statement: { x: 1 } },
        ] as unknown as IntentCommandInput["requirements"]),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      normalizeIntentCommand(
        baseInput([
          { dimension: "cost", classification: "mandatory", statement: { x: 1 } },
        ] as unknown as IntentCommandInput["requirements"]),
      ),
    ).toThrow(ValidationError);
  });

  it("rejects missing statements and non-JSON statements", () => {
    expect(() =>
      normalizeIntentCommand(
        baseInput([
          { dimension: "cost", classification: "soft" } as unknown as IntentCommandInput["requirements"][number],
        ]),
      ),
    ).toThrow(ValidationError);
  });

  it("rejects an inverted or oversized validity window", () => {
    expect(() =>
      normalizeIntentCommand({
        ...baseInput(),
        validity: { start: "2026-02-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      normalizeIntentCommand({
        ...baseInput(),
        validity: { start: "2026-01-01T00:00:00.000Z", end: "2027-01-03T00:00:00.000Z" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects naive timestamps, bad tenants and non-UUID source ids", () => {
    expect(() =>
      normalizeIntentCommand({ ...baseInput(), validity: { start: "2026-01-15T08:30:00", end: "2026-01-16T08:30:00.000Z" } }),
    ).toThrow(ValidationError);
    expect(() => normalizeIntentCommand({ ...baseInput(), tenantId: "tenant-oops" })).toThrow(ValidationError);
    expect(() => normalizeIntentCommand({ ...baseInput(), sourceIntentId: "not-a-uuid" })).toThrow(
      ValidationError,
    );
  });

  it("rejects an invalid termination policy", () => {
    expect(() =>
      normalizeIntentCommand({
        ...baseInput(),
        termination: { actor: "nobody", onExpiry: "release" } as unknown as IntentCommandInput["termination"],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      normalizeIntentCommand({
        ...baseInput(),
        termination: { actor: "customer", onExpiry: "explode" } as unknown as IntentCommandInput["termination"],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects non-canonicalizable statement payloads", () => {
    const bad = { dimension: "cost", classification: "soft", statement: undefined };
    expect(() =>
      normalizeIntentCommand(baseInput([bad as unknown as IntentCommandInput["requirements"][number]])),
    ).toThrow(ValidationError);
  });

  it("validation failures never echo offending values (RL-LOCK-016)", () => {
    try {
      normalizeIntentCommand({ ...baseInput(), tenantId: "SUPER SECRET TENANT" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).not.toContain("SUPER SECRET TENANT");
    }
  });
});

describe("compileIntentCommand runs the closed v2 request schema (boundary)", () => {
  it("accepts the optional commercial/service fields and superseded contract", () => {
    const draft = compileIntentCommand(
      {
        ...baseInput(),
        serviceProperties: { priority: "standard" },
        supersededContract: "contract-77",
      },
      { at: T0, commandId: COMMAND_ID },
    );
    const request = draft.request as unknown as Record<string, unknown>;
    expect(request["service_properties"]).toEqual({ priority: "standard" });
    expect(request["superseded_contract"]).toBe("contract-77");
  });

  it("preserves source intent id + version for traceability (RL-012 contract)", () => {
    const draft = compileIntentCommand(baseInput(), { at: T0, commandId: COMMAND_ID });
    expect(draft.envelope.intentVersion).toBe(3);
    expect(draft.envelope.correlationId).toContain(baseInput().sourceIntentVersionId);
    // the normalized model is part of the draft for auditing/projection
    expect(draft.normalized.validity.start).toBe(T0);
  });

  it("uses fixture-compatible ids: user-scoped tenants parse (no cross-domain leakage)", () => {
    const draft = compileIntentCommand(
      { ...baseInput(), tenantId: `usr:${fixtureUserId(2)}` },
      { at: T0, commandId: COMMAND_ID },
    );
    expect(draft.envelope.tenantId).toBe(`usr:${fixtureUserId(2)}`);
  });
});
