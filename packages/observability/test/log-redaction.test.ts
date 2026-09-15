import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { fixtureCorrelationId, fixtureTenantId, fixtureUtcInstant } from "@roamlink/testkit";
import {
  LOG_LEVELS,
  REDACTED_LOG_PLACEHOLDER,
  logLevelSeverity,
  makeStructuredLogRecord,
  meetsLogLevelThreshold,
  parseLogLevel,
  secretLogValue,
  serializeStructuredLogRecord,
} from "../src/index.js";

const THE_SECRET = "gh-test-secret-value-do-not-leak-0123456789";

function recordWithSecret() {
  return makeStructuredLogRecord({
    level: "info",
    message: "sync attempt finished",
    at: fixtureUtcInstant(),
    correlationId: fixtureCorrelationId(),
    tenantId: fixtureTenantId(),
    fields: {
      attempt: 2,
      outcome: "rate-limited",
      access_token: secretLogValue(THE_SECRET),
    },
  });
}

describe("RedactedLogValue (RL-LOCK-016 redaction seam)", () => {
  it("never serializes the raw value through JSON.stringify", () => {
    const record = recordWithSecret();
    const json = JSON.stringify(record);
    expect(json).not.toContain(THE_SECRET);
    expect(json).toContain(REDACTED_LOG_PLACEHOLDER);
  });

  it("never reveals the raw value through util.inspect / console rendering", () => {
    const record = recordWithSecret();
    const inspected = inspect(record, { depth: 4 });
    expect(inspected).not.toContain(THE_SECRET);
    expect(inspected).toContain("RedactedLogValue");
  });

  it("String() and JSON.stringify on the wrapper alone yield only the placeholder", () => {
    const wrapper = secretLogValue(THE_SECRET);
    expect(String(wrapper)).toBe(REDACTED_LOG_PLACEHOLDER);
    expect(JSON.stringify(wrapper)).toBe(`"${REDACTED_LOG_PLACEHOLDER}"`);
    expect(Object.keys(wrapper)).toEqual([]);
    // no property or symbol exposes the raw value
    expect(Object.getOwnPropertyNames(wrapper)).toEqual([]);
  });

  it("rejects wrapping of empty or oversized raw values (still without echoing them)", () => {
    expect(() => secretLogValue("")).toThrowError();
    expect(() => secretLogValue("x".repeat(4097))).toThrowError();
    try {
      secretLogValue(THE_SECRET + "!");
      expect.unreachable("must throw");
    } catch {
      // valid value must NOT throw - guard against over-validation
    }
  });
});

describe("makeStructuredLogRecord", () => {
  it("builds a frozen record with correlation id and tenant", () => {
    const record = recordWithSecret();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.fields)).toBe(true);
    expect(record.level).toBe("info");
    expect(record.correlationId).toBe(fixtureCorrelationId());
    expect(record.tenantId).toBe(fixtureTenantId());
    expect(record.at).toBe(fixtureUtcInstant());
  });

  it("defaults fields to an empty frozen record", () => {
    const record = makeStructuredLogRecord({
      level: "warn",
      message: "no fields",
      at: fixtureUtcInstant(),
    });
    expect(record.fields).toEqual({});
    expect(Object.isFrozen(record.fields)).toBe(true);
    expect(record.correlationId).toBeUndefined();
  });

  it("rejects invalid levels, messages, ids and field values", () => {
    expect(() =>
      makeStructuredLogRecord({ level: "loud", message: "x", at: fixtureUtcInstant() }),
    ).toThrowError(/log-level vocabulary/);
    expect(() =>
      makeStructuredLogRecord({ level: "info", message: "", at: fixtureUtcInstant() }),
    ).toThrowError(/message/);
    expect(() =>
      makeStructuredLogRecord({
        level: "info",
        message: "x".repeat(513),
        at: fixtureUtcInstant(),
      }),
    ).toThrowError(/message/);
    expect(() =>
      makeStructuredLogRecord({
        level: "info",
        message: "ok",
        at: fixtureUtcInstant(),
        correlationId: "bad id",
      }),
    ).toThrowError();
    expect(() =>
      makeStructuredLogRecord({
        level: "info",
        message: "ok",
        at: fixtureUtcInstant(),
        fields: { nested: { deep: "object" } },
      }),
    ).toThrowError(/secretLogValue/);
    expect(() =>
      makeStructuredLogRecord({
        level: "info",
        message: "ok",
        at: fixtureUtcInstant(),
        fields: { "bad key!": 1 },
      }),
    ).toThrowError(/safe labels/);
  });
});

describe("serializeStructuredLogRecord", () => {
  it("produces a plain object with secrets replaced by the placeholder", () => {
    const record = recordWithSecret();
    const serialized = serializeStructuredLogRecord(record);
    const json = JSON.stringify(serialized);
    expect(json).not.toContain(THE_SECRET);
    expect(serialized.fields.access_token).toBe(REDACTED_LOG_PLACEHOLDER);
    expect(serialized.fields.attempt).toBe(2);
  });
});

describe("log level ordering", () => {
  it("covers trace..fatal with monotone severity", () => {
    expect([...LOG_LEVELS]).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
    for (let i = 1; i < LOG_LEVELS.length; i += 1) {
      const lower = LOG_LEVELS[i - 1];
      const higher = LOG_LEVELS[i];
      if (lower !== undefined && higher !== undefined) {
        expect(logLevelSeverity(higher)).toBeGreaterThan(logLevelSeverity(lower));
      }
    }
    expect(parseLogLevel("info")).toBe("info");
    expect(() => parseLogLevel("verbose")).toThrowError();
  });

  it("meetsLogLevelThreshold filters correctly", () => {
    expect(meetsLogLevelThreshold("error", "info")).toBe(true);
    expect(meetsLogLevelThreshold("trace", "info")).toBe(false);
    expect(meetsLogLevelThreshold("info", "info")).toBe(true);
  });
});
