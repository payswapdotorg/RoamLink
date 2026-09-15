import { describe, expect, it } from "vitest";
import {
  CommandEnvelope,
  type CommandEnvelopeInput,
} from "../src/envelope/command-envelope.js";
import { ValidationError } from "../src/errors/errors.js";

const ORG = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

function validInput(overrides: Partial<CommandEnvelopeInput> = {}): CommandEnvelopeInput {
  return {
    commandId: "3b241101-e2bb-4255-8caf-4136c566a962",
    correlationId: "corr-2026-09-15-001",
    idempotencyKey: "idem-order-create-001",
    actorId: "service-experience-api",
    tenantId: `org:${ORG}`,
    intentVersion: 3,
    createdAt: "2026-09-15T12:00:00.000Z",
    retry: { attempt: 1 },
    ...overrides,
  };
}

describe("CommandEnvelope (spec/adcos-integration.md §5, RL-LOCK-014)", () => {
  it("constructs a valid, deeply frozen envelope", () => {
    const envelope = new CommandEnvelope(validInput());
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.retry)).toBe(true);
    expect(envelope.commandId).toBe("3b241101-e2bb-4255-8caf-4136c566a962");
    expect(envelope.correlationId).toBe("corr-2026-09-15-001");
    expect(envelope.idempotencyKey).toBe("idem-order-create-001");
    expect(envelope.intentVersion).toBe(3);
    expect(envelope.orderVersion).toBeUndefined();
    expect(envelope.createdAt).toBe("2026-09-15T12:00:00.000Z");
    expect(envelope.retry.attempt).toBe(1);
    expect("lastError" in envelope.retry).toBe(false);
  });

  it("REJECTS missing correlationId and idempotencyKey", () => {
    expect(() => new CommandEnvelope(validInput({ correlationId: "" }))).toThrowError(ValidationError);
    expect(() => new CommandEnvelope(validInput({ idempotencyKey: "" }))).toThrowError(ValidationError);
    const { correlationId: _omitCorrelation, ...withoutCorrelation } = validInput();
    const { idempotencyKey: _omitIdempotency, ...withoutIdempotency } = validInput();
    expect(() =>
      new CommandEnvelope(withoutCorrelation as unknown as CommandEnvelopeInput),
    ).toThrowError(/correlationId/);
    expect(() =>
      new CommandEnvelope(withoutIdempotency as unknown as CommandEnvelopeInput),
    ).toThrowError(/idempotencyKey/);
  });

  it("rejects every other missing or malformed required field", () => {
    const cases: readonly [string, Partial<CommandEnvelopeInput>][] = [
      ["commandId", { commandId: "not-a-uuid" }],
      ["commandId", { commandId: "" }],
      ["actorId", { actorId: "" }],
      ["tenantId", { tenantId: "nonsense" }],
      ["tenantId", { tenantId: ORG }],
      ["createdAt", { createdAt: "2026-09-15T12:00:00" }], // naive timestamp rejected
      ["retry", { retry: { attempt: 0 } }],
      ["retry", { retry: { attempt: 1.5 } }],
      ["retry", { retry: { attempt: -1 } }],
      ["retry", { retry: { attempt: 2, lastError: { reason: "bad reason", kind: "unavailable", occurredAt: "2026-09-15T12:00:00.000Z" } } }],
      ["retry", { retry: { attempt: 2, lastError: { reason: "UNAVAILABLE", kind: "made-up-kind", occurredAt: "2026-09-15T12:00:00.000Z" } } }],
      ["retry", { retry: { attempt: 2, lastError: { reason: "UNAVAILABLE", kind: "unavailable", occurredAt: "2026-09-15T12:00:00" } } }],
      ["intentVersion", { intentVersion: 0 }],
      ["intentVersion", { intentVersion: -3 }],
      ["intentVersion", { intentVersion: 2.5 }],
      ["orderVersion", { orderVersion: 0 }],
    ];
    for (const [label, overrides] of cases) {
      expect(() => new CommandEnvelope(validInput(overrides)), `${label}: ${JSON.stringify(overrides)}`).toThrowError(ValidationError);
    }
  });

  it("rejects unknown input fields (exact §5 field set)", () => {
    const input = { ...validInput(), extraField: "nope" } as unknown as CommandEnvelopeInput;
    expect(() => new CommandEnvelope(input)).toThrowError(/extraField/);
  });

  it("rejects non-object input", () => {
    expect(() => new CommandEnvelope(null as unknown as CommandEnvelopeInput)).toThrowError(ValidationError);
    expect(() => new CommandEnvelope([] as unknown as CommandEnvelopeInput)).toThrowError(ValidationError);
    expect(() => CommandEnvelope.fromPlain("junk")).toThrowError(ValidationError);
  });

  it("accepts valid retry metadata and canonicalizes its timestamp", () => {
    const envelope = new CommandEnvelope(
      validInput({
        retry: {
          attempt: 2,
          lastError: {
            reason: "UNAVAILABLE",
            kind: "unavailable",
            occurredAt: "2026-09-15T14:00:00+02:00",
          },
        },
      }),
    );
    expect(envelope.retry.attempt).toBe(2);
    expect(envelope.retry.lastError?.occurredAt).toBe("2026-09-15T12:00:00.000Z");
    expect(Object.isFrozen(envelope.retry.lastError)).toBe(true);
  });

  it("toPlain/fromPlain round-trip preserves value and digest", () => {
    const envelope = new CommandEnvelope(validInput({ orderVersion: 7 }));
    const plain = envelope.toPlain();
    const restored = CommandEnvelope.fromPlain(JSON.parse(JSON.stringify(plain)));
    expect(restored.toPlain()).toEqual(plain);
    expect(restored.digest()).toBe(envelope.digest());
    expect(restored.canonicalJson()).toBe(envelope.canonicalJson());
  });

  it("serialization is deterministic regardless of construction order", () => {
    const first = new CommandEnvelope(validInput());
    const second = new CommandEnvelope(
      validInput({
        retry: { attempt: 1 },
        createdAt: "2026-09-15T14:00:00+02:00", // same instant, different expression
      }),
    );
    expect(second.canonicalJson()).toBe(first.canonicalJson());
    expect(second.digest()).toBe(first.digest());
    expect(first.digest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("plain form carries exactly the set fields (exact §5 field set)", () => {
    const plain = new CommandEnvelope(validInput()).toPlain(); // intentVersion: 3 set
    expect(Object.keys(plain).sort()).toEqual(
      ["actorId", "commandId", "correlationId", "createdAt", "idempotencyKey", "intentVersion", "retry", "tenantId"],
    );
    const withBoth = new CommandEnvelope(validInput({ orderVersion: 2 })).toPlain();
    expect(Object.keys(withBoth).sort()).toEqual(
      ["actorId", "commandId", "correlationId", "createdAt", "idempotencyKey", "intentVersion", "orderVersion", "retry", "tenantId"],
    );
    const withNeither = new CommandEnvelope(
      validInput({ intentVersion: undefined } as unknown as Partial<CommandEnvelopeInput>),
    );
    expect(Object.keys(withNeither.toPlain()).sort()).toEqual(
      ["actorId", "commandId", "correlationId", "createdAt", "idempotencyKey", "retry", "tenantId"],
    );
    // unset optional fields are not even own properties of the envelope
    expect("intentVersion" in withNeither).toBe(false);
    expect("orderVersion" in withNeither).toBe(false);
  });

  it("is immutable after construction", () => {
    const envelope = new CommandEnvelope(validInput());
    expect(() => {
      const mutable = envelope as unknown as { commandId: string };
      mutable.commandId = "3b241101-e2bb-4255-8caf-4136c566a963";
    }).toThrowError(TypeError);
  });

  it("error messages never echo input values (RL-LOCK-016)", () => {
    const sentinel = "sentinel-secret-idempotency-value";
    let message = "";
    try {
      new CommandEnvelope(validInput({ idempotencyKey: `${sentinel} with spaces` }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(sentinel);
    expect(message).toContain("idempotencyKey");
  });
});
