import { describe, expect, it } from "vitest";
import { fixtureCommandEnvelope, fixtureUtcInstant } from "@roamlink/testkit";
import {
  correlationContextFromCommandEnvelope,
  createAsyncCorrelationCarrier,
  createCorrelatedLogger,
  createInMemoryLogSink,
  secretLogValue,
} from "../src/index.js";

describe("createCorrelatedLogger", () => {
  it("auto-fills correlation id and tenant from the current context", async () => {
    const sink = createInMemoryLogSink();
    const carrier = createAsyncCorrelationCarrier();
    const logger = createCorrelatedLogger({
      sink: sink.sink,
      carrier,
      now: () => fixtureUtcInstant(),
    });
    const envelope = fixtureCommandEnvelope({ seed: 9 });

    await carrier.run(correlationContextFromCommandEnvelope(envelope), async () => {
      logger.info("sync completed", { attempt: 1, session_token: secretLogValue("abc") });
    });

    expect(sink.records()).toHaveLength(1);
    const record = sink.records()[0];
    expect(record?.correlationId).toBe(envelope.correlationId);
    expect(record?.tenantId).toBe(envelope.tenantId);
    expect(record?.at).toBe(fixtureUtcInstant());
    expect(JSON.stringify(record)).not.toContain("abc");
  });

  it("records carry no correlation id outside a context scope", () => {
    const sink = createInMemoryLogSink();
    const logger = createCorrelatedLogger({
      sink: sink.sink,
      carrier: createAsyncCorrelationCarrier(),
      now: () => fixtureUtcInstant(),
    });
    logger.warn("orphan warning");
    const record = sink.records()[0];
    expect(record?.correlationId).toBeUndefined();
    expect(record?.tenantId).toBeUndefined();
    expect(record?.level).toBe("warn");
  });

  it("drops records below the minimum level", () => {
    const sink = createInMemoryLogSink();
    const logger = createCorrelatedLogger({
      sink: sink.sink,
      carrier: createAsyncCorrelationCarrier(),
      minLevel: "warn",
      now: () => fixtureUtcInstant(),
    });
    logger.trace("nope");
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    logger.error("yes");
    expect(sink.records()).toHaveLength(2);
    sink.clear();
    expect(sink.records()).toHaveLength(0);
  });

  it("rejects an invalid min level and fails fast on invalid messages", () => {
    const sink = createInMemoryLogSink();
    expect(() =>
      createCorrelatedLogger({
        sink: sink.sink,
        carrier: createAsyncCorrelationCarrier(),
        minLevel: "loud",
      }),
    ).toThrowError(/log-level vocabulary/);
    const logger = createCorrelatedLogger({
      sink: sink.sink,
      carrier: createAsyncCorrelationCarrier(),
      now: () => fixtureUtcInstant(),
    });
    expect(() => logger.info("")).toThrowError(/message/);
    expect(() => logger.info("ok", { nested: {} } as never)).toThrowError(/secretLogValue/);
    expect(sink.records()).toHaveLength(0);
  });
});
