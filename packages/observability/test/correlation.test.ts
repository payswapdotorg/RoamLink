import { describe, expect, it } from "vitest";
import { fixtureCommandEnvelope } from "@roamlink/testkit";
import {
  correlationContextFromCommandEnvelope,
  createAsyncCorrelationCarrier,
  createManualCorrelationCarrier,
  makeCorrelationContext,
} from "../src/index.js";

describe("correlationContextFromCommandEnvelope", () => {
  it("propagates the Wave-0 envelope's correlation identity", () => {
    const envelope = fixtureCommandEnvelope({ seed: 7 });
    const context = correlationContextFromCommandEnvelope(envelope);
    expect(context.correlationId).toBe(envelope.correlationId);
    expect(context.tenantId).toBe(envelope.tenantId);
    expect(context.commandId).toBe(envelope.commandId);
    expect(context.actorId).toBe(envelope.actorId);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("accepts the plain envelope form identically", () => {
    const plain = fixtureCommandEnvelope({ seed: 7 }).toPlain();
    expect(correlationContextFromCommandEnvelope(plain).correlationId).toBe(plain.correlationId);
  });
});

describe("makeCorrelationContext", () => {
  it("validates every field through the Wave-0 parsers", () => {
    const context = makeCorrelationContext({
      correlationId: "corr-42",
      tenantId: "org:00000000-0000-4000-8000-000000000001",
    });
    expect(context.correlationId).toBe("corr-42");
    expect(context.tenantId).toBe("org:00000000-0000-4000-8000-000000000001");
    expect(context.commandId).toBeUndefined();

    expect(() => makeCorrelationContext({ correlationId: "bad id!" })).toThrowError();
    expect(() =>
      makeCorrelationContext({ correlationId: "ok", tenantId: "not-a-tenant" }),
    ).toThrowError();
  });
});

describe("createAsyncCorrelationCarrier", () => {
  it("propagates the context across await boundaries", async () => {
    const carrier = createAsyncCorrelationCarrier();
    const context = correlationContextFromCommandEnvelope(fixtureCommandEnvelope());
    const seen = await carrier.run(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await Promise.resolve();
      return carrier.current();
    });
    expect(seen?.correlationId).toBe(context.correlationId);
  });

  it("returns undefined outside any run scope", () => {
    const carrier = createAsyncCorrelationCarrier();
    expect(carrier.current()).toBeUndefined();
  });

  it("isolates concurrent run scopes (no cross-talk)", async () => {
    const carrier = createAsyncCorrelationCarrier();
    const first = correlationContextFromCommandEnvelope(fixtureCommandEnvelope({ seed: 1 }));
    const second = correlationContextFromCommandEnvelope(fixtureCommandEnvelope({ seed: 2 }));

    const probe = async (delayMs: number): Promise<string | undefined> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return carrier.current()?.correlationId;
    };

    const results = await Promise.all([
      carrier.run(first, () => probe(10)),
      carrier.run(second, () => probe(1)),
    ]);
    expect(results[0]).toBe(first.correlationId);
    expect(results[1]).toBe(second.correlationId);
    expect(carrier.current()).toBeUndefined();
  });
});

describe("createManualCorrelationCarrier", () => {
  it("sets and restores the context around the synchronous extent of run", () => {
    const carrier = createManualCorrelationCarrier();
    const first = makeCorrelationContext({ correlationId: "corr-1" });
    const second = makeCorrelationContext({ correlationId: "corr-2" });

    expect(carrier.current()).toBeUndefined();
    carrier.run(first, () => {
      expect(carrier.current()?.correlationId).toBe("corr-1");
      carrier.run(second, () => {
        expect(carrier.current()?.correlationId).toBe("corr-2");
      });
      expect(carrier.current()?.correlationId).toBe("corr-1");
    });
    expect(carrier.current()).toBeUndefined();
  });

  it("restores the previous context even when fn throws", () => {
    const carrier = createManualCorrelationCarrier();
    const outer = makeCorrelationContext({ correlationId: "corr-outer" });
    carrier.run(outer, () => {
      expect(() =>
        carrier.run(makeCorrelationContext({ correlationId: "corr-inner" }), () => {
          throw new Error("boom");
        }),
      ).toThrowError("boom");
      expect(carrier.current()?.correlationId).toBe("corr-outer");
    });
  });
});
