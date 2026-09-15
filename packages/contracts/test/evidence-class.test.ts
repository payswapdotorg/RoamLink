import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CLASSES,
  EVIDENCE_CLASS_DESCRIPTIONS,
  describeEvidenceClass,
  isEvidenceClass,
  parseEvidenceClass,
} from "../src/evidence/evidence-class.js";
import { ValidationError } from "../src/errors/errors.js";

describe("evidence classes (frozen vocabulary, RL-LOCK-010)", () => {
  it("the vocabulary is closed and exactly the seven spec classes", () => {
    expect([...EVIDENCE_CLASSES]).toEqual([
      "AUTHENTICATED",
      "OBSERVED",
      "REPORTED",
      "DERIVED",
      "INFERRED",
      "STALE",
      "UNKNOWN",
    ]);
  });

  it("parses every member of the vocabulary", () => {
    for (const evidenceClass of EVIDENCE_CLASSES) {
      expect(parseEvidenceClass(evidenceClass)).toBe(evidenceClass);
      expect(isEvidenceClass(evidenceClass)).toBe(true);
    }
  });

  it("UNKNOWN is a valid state, not an error", () => {
    expect(() => parseEvidenceClass("UNKNOWN")).not.toThrow();
    expect(parseEvidenceClass("UNKNOWN")).toBe("UNKNOWN");
  });

  it("rejects everything outside the closed vocabulary", () => {
    for (const bad of [
      "",
      "authenticated", // lowercase
      "TRUSTED",
      "VERIFIED",
      "GUESSED",
      "unknown ",
      "AUTHENTICATED|OBSERVED",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(() => parseEvidenceClass(bad), `value kind: ${typeof bad}`).toThrowError(ValidationError);
      expect(isEvidenceClass(bad)).toBe(false);
    }
  });

  it("describes every class using the authority-model wording", () => {
    for (const evidenceClass of EVIDENCE_CLASSES) {
      const description = describeEvidenceClass(evidenceClass);
      expect(description.length).toBeGreaterThan(10);
      expect(EVIDENCE_CLASS_DESCRIPTIONS[evidenceClass]).toBe(description);
    }
    // spot-check two canonical wordings
    expect(EVIDENCE_CLASS_DESCRIPTIONS.UNKNOWN).toContain("not equivalent to failure");
    expect(EVIDENCE_CLASS_DESCRIPTIONS.INFERRED).toContain("never canonical");
  });
});
