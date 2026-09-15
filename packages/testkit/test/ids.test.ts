import { describe, expect, it } from "vitest";
import { CANONICAL_UUID_PATTERN, NIL_UUID, isCanonicalUuid } from "@roamlink/contracts";
import {
  DeterministicUuidGenerator,
  MAX_DETERMINISTIC_UUID_SEED,
  SequenceIdGenerator,
  deterministicUuidFromSeed,
} from "../src/index.js";

describe("deterministicUuidFromSeed", () => {
  it("produces canonical, non-nil UUIDs", () => {
    for (const seed of [1, 2, 42, 999_999, MAX_DETERMINISTIC_UUID_SEED]) {
      const uuid = deterministicUuidFromSeed(seed);
      expect(CANONICAL_UUID_PATTERN.test(uuid)).toBe(true);
      expect(uuid).not.toBe(NIL_UUID);
      expect(isCanonicalUuid(uuid)).toBe(true);
    }
  });

  it("is deterministic for the same seed and distinct across seeds", () => {
    expect(deterministicUuidFromSeed(7)).toBe(deterministicUuidFromSeed(7));
    expect(deterministicUuidFromSeed(7)).not.toBe(deterministicUuidFromSeed(8));
  });

  it("rejects seeds outside the encodable range", () => {
    expect(() => deterministicUuidFromSeed(0)).toThrowError(/seed/);
    expect(() => deterministicUuidFromSeed(-1)).toThrowError(/seed/);
    expect(() => deterministicUuidFromSeed(1.5)).toThrowError(/seed/);
    expect(() => deterministicUuidFromSeed(MAX_DETERMINISTIC_UUID_SEED + 1)).toThrowError(/seed/);
  });
});

describe("DeterministicUuidGenerator", () => {
  it("yields the deterministic sequence from its start seed", () => {
    const generator = new DeterministicUuidGenerator();
    expect(generator.next()).toBe(deterministicUuidFromSeed(1));
    expect(generator.next()).toBe(deterministicUuidFromSeed(2));
    expect(generator.next()).toBe(deterministicUuidFromSeed(3));
  });

  it("honors a custom start seed", () => {
    const generator = new DeterministicUuidGenerator(100);
    expect(generator.next()).toBe(deterministicUuidFromSeed(100));
    expect(generator.next()).toBe(deterministicUuidFromSeed(101));
  });

  it("never repeats a value within its range", () => {
    const generator = new DeterministicUuidGenerator(1);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(generator.next());
    }
    expect(seen.size).toBe(500);
  });

  it("rejects an invalid start seed", () => {
    expect(() => new DeterministicUuidGenerator(0)).toThrowError();
  });
});

describe("SequenceIdGenerator", () => {
  it("defaults to id-1, id-2, ...", () => {
    const generator = new SequenceIdGenerator();
    expect(generator.next()).toBe("id-1");
    expect(generator.next()).toBe("id-2");
  });

  it("supports a custom prefix and start", () => {
    const generator = new SequenceIdGenerator({ prefix: "evt_", start: 10 });
    expect(generator.next()).toBe("evt_10");
    expect(generator.next()).toBe("evt_11");
  });

  it("supports an empty prefix (bare numbers)", () => {
    const generator = new SequenceIdGenerator({ prefix: "", start: 0 });
    expect(generator.next()).toBe("0");
    expect(generator.next()).toBe("1");
  });

  it("rejects an unsafe prefix and a non-integer start", () => {
    expect(() => new SequenceIdGenerator({ prefix: "bad prefix!" })).toThrowError(/prefix/);
    expect(() => new SequenceIdGenerator({ start: -1 })).toThrowError(/start/);
    expect(() => new SequenceIdGenerator({ start: 1.5 })).toThrowError(/start/);
  });
});
