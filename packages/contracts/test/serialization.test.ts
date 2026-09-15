import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  isCanonicalJsonValue,
} from "../src/serialization/canonical-json.js";
import {
  canonicalJsonDigest,
  isDigest,
  parseDigest,
  sha256Hex,
} from "../src/serialization/digest.js";
import { ValidationError } from "../src/errors/errors.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ b: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":4}}');
    // integer-like keys are re-sorted too (JS object key order would differ)
    expect(canonicalizeJson({ b: 1, "2": "two", a: 0 })).toBe('{"2":"two","a":0,"b":1}');
  });

  it("sorts keys by UTF-16 code units (never locale)", () => {
    expect(canonicalizeJson({ a: 1, A: 2, "0": 3, " ": 4 })).toBe('{" ":4,"0":3,"A":2,"a":1}');
  });

  it("is deterministic across different key insertion orders (same value -> same digest)", () => {
    const first = { b: { d: 2, c: 3 }, a: 1, list: [1, { z: true, y: false }] };
    const second = { list: [1, { y: false, z: true }], a: 1, b: { c: 3, d: 2 } };
    expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
    expect(canonicalJsonDigest(second)).toBe(canonicalJsonDigest(first));
    expect(canonicalJsonDigest(second)).toBe(
      sha256Hex('{"a":1,"b":{"c":3,"d":2},"list":[1,{"y":false,"z":true}]}'),
    );
  });

  it("preserves array order (order is semantic)", () => {
    expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalizeJson([2, 1])).not.toBe(canonicalizeJson([1, 2]));
  });

  it("serializes scalars and strings with exact escaping", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(true)).toBe("true");
    expect(canonicalizeJson(-12)).toBe("-12");
    expect(canonicalizeJson(1.25)).toBe("1.25");
    expect(canonicalizeJson(-0)).toBe("0");
    expect(canonicalizeJson("æ\n\"q\\")).toBe('"æ\\n\\"q\\\\"');
    expect(canonicalizeJson([])).toBe("[]");
    expect(canonicalizeJson({})).toBe("{}");
  });

  it("uses the ECMAScript number formatting (stable across engines)", () => {
    expect(canonicalizeJson(1e21)).toBe("1e+21");
    expect(canonicalizeJson(1e-7)).toBe("1e-7");
  });

  it("rejects non-canonicalizable values with path-precise errors", () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrowError(ValidationError);
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrowError(ValidationError);
    expect(() => canonicalizeJson(undefined)).toThrowError(ValidationError);
    expect(() => canonicalizeJson(() => 1)).toThrowError(ValidationError);
    expect(() => canonicalizeJson(10n)).toThrowError(ValidationError);
    expect(() => canonicalizeJson(new Date(0))).toThrowError(/Date/);
    expect(() => canonicalizeJson(new Map())).toThrowError(ValidationError);
    expect(() => canonicalizeJson({ ok: 1, nested: new Date(0) })).toThrowError(/\.nested/);
    expect(() => canonicalizeJson({ a: undefined })).toThrowError(/\.a/);
    const holey: unknown[] = [1, 2, 3];
    delete holey[1]; // create a real hole without sparse-array literal syntax
    expect(() => canonicalizeJson(holey)).toThrowError(ValidationError);
    expect(() => canonicalizeJson([1, undefined])).toThrowError(ValidationError);
    class Plain {}
    expect(() => canonicalizeJson(new Plain())).toThrowError(ValidationError);
  });

  it("rejects circular references", () => {
    const value: Record<string, unknown> = { a: 1 };
    value["self"] = value;
    expect(() => canonicalizeJson(value)).toThrowError(/circular/);
  });

  it("isCanonicalJsonValue performs the structural check", () => {
    expect(isCanonicalJsonValue({ a: [1, "x", null, true] })).toBe(true);
    expect(isCanonicalJsonValue({ d: new Date() })).toBe(false);
    expect(isCanonicalJsonValue([1, undefined])).toBe(false);
    expect(isCanonicalJsonValue(3)).toBe(true);
  });
});

describe("digest", () => {
  it("sha256Hex matches known answer vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("canonicalJsonDigest composes sha256 over the canonical form", () => {
    expect(canonicalJsonDigest({ a: 1 })).toBe(sha256Hex('{"a":1}'));
    expect(canonicalJsonDigest({ b: 2, a: 1 })).toBe(sha256Hex('{"a":1,"b":2}'));
    // precomputed vector locks the composition against drift
    expect(canonicalJsonDigest({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(canonicalJsonDigest({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });

  it("same logical value in different key order produces identical digests", () => {
    const a = { x: { y: 1, z: 2 }, w: [3, { q: "r", p: "s" }] };
    const b = { w: [3, { p: "s", q: "r" }], x: { z: 2, y: 1 } };
    expect(canonicalJsonDigest(a)).toBe(canonicalJsonDigest(b));
  });

  it("digest type guards and parser", () => {
    const digest = sha256Hex("abc");
    expect(isDigest(digest)).toBe(true);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parseDigest(digest)).toBe(digest);
    for (const bad of ["", "XYZ", digest.toUpperCase(), `${digest}0`, 42, null]) {
      expect(() => parseDigest(bad)).toThrowError(ValidationError);
      expect(isDigest(bad)).toBe(false);
    }
  });
});
