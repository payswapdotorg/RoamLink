import { describe, expect, it } from "vitest";
import { fixtureCommandEnvelope, fixtureIdempotencyKey } from "../src/index.js";
import { CommandEnvelopeRecorder, Recorder } from "../src/index.js";

describe("Recorder", () => {
  it("records events in order and snapshots them frozen", () => {
    const recorder = new Recorder<string>();
    recorder.record("first");
    recorder.record("second");
    recorder.recordAll(["third", "fourth"]);
    expect(recorder.events()).toEqual(["first", "second", "third", "fourth"]);
    expect(Object.isFrozen(recorder.events())).toBe(true);
  });

  it("supports size, last, filter and clear", () => {
    const recorder = new Recorder<number>();
    expect(recorder.size()).toBe(0);
    expect(recorder.last()).toBeUndefined();
    recorder.record(1);
    recorder.record(2);
    recorder.record(3);
    expect(recorder.size()).toBe(3);
    expect(recorder.last()).toBe(3);
    expect(recorder.filter((n) => n % 2 === 1)).toEqual([1, 3]);
    recorder.clear();
    expect(recorder.size()).toBe(0);
    expect(recorder.events()).toEqual([]);
  });

  it("returns independent snapshots (clearing does not mutate old snapshots)", () => {
    const recorder = new Recorder<string>();
    recorder.record("kept");
    const snapshot = recorder.events();
    recorder.clear();
    expect(snapshot).toEqual(["kept"]);
  });
});

describe("CommandEnvelopeRecorder", () => {
  it("stores frozen plain copies of class envelopes", () => {
    const recorder = new CommandEnvelopeRecorder();
    const envelope = fixtureCommandEnvelope();
    recorder.record(envelope);
    const stored = recorder.envelopes()[0];
    expect(stored).toBeDefined();
    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored?.commandId).toBe(envelope.commandId);
  });

  it("queries by command, correlation and idempotency identity", () => {
    const recorder = new CommandEnvelopeRecorder();
    const first = fixtureCommandEnvelope({ seed: 1 });
    const second = fixtureCommandEnvelope({ seed: 2 });
    const retryOfSecond = fixtureCommandEnvelope({
      seed: 2,
      attempt: 2,
      commandId: "00000000-0000-4000-8000-0000000000ff",
    });
    recorder.record(first);
    recorder.record(second);
    recorder.record(retryOfSecond);

    expect(recorder.size()).toBe(3);
    expect(recorder.byCommandId(first.commandId)).toHaveLength(1);
    expect(recorder.byCorrelationId(second.correlationId)).toHaveLength(2);
    expect(recorder.byIdempotencyKey(second.idempotencyKey)).toHaveLength(2);
    expect(recorder.attemptsByIdempotencyKey(second.idempotencyKey)).toBe(2);
    expect(recorder.attemptsByIdempotencyKey(fixtureIdempotencyKey(99))).toBe(0);
    recorder.clear();
    expect(recorder.size()).toBe(0);
  });

  it("records plain envelopes directly", () => {
    const recorder = new CommandEnvelopeRecorder();
    const plain = fixtureCommandEnvelope({ seed: 5 }).toPlain();
    recorder.record(plain);
    expect(recorder.byCommandId(plain.commandId)).toHaveLength(1);
  });
});
