/**
 * RL-LOCK-012 conformance suite: AI is advisory.
 *
 * AI may explain, rank, summarize or propose experience preferences, but
 * it cannot authorize connectivity commands or override deterministic
 * policy/authority boundaries.
 *
 * MECHANICAL-TESTABILITY NOTE (documented per the RL-070 brief): no AI
 * component exists in the tree yet, so "an AI authorizing a command" is
 * not directly executable today. The strongest executable proxies are:
 *
 *  1. SUPPLY CHAIN: no AI/LLM SDK is imported or depended on anywhere in
 *     production sources (the shape an unauthorized AI component would
 *     first need); a planted SDK import turns the scan red.
 *  2. ADVISORY OUTPUT IS EVIDENCE-WEIGHTED, NEVER AUTHORITATIVE: the
 *     ExperienceDecision read model (the advisory surface, RL-013) weighs
 *     every input by its evidence class + freshness, STALE and UNKNOWN
 *     evidence weigh ZERO, and the decision record has NO command or
 *     authorization field at all - it references connectivity, it never
 *     authorizes it.
 *  3. DETERMINISM: advisory computation is a pure function of its inputs
 *     (identical inputs, identical output) - there is no ambient
 *     authority channel an advisory component could ride.
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - a planted AI SDK import in a domain package turns the scan red
 *    (toggle RL-LOCK-012);
 *  - an advisory decision computed from STALE/UNKNOWN evidence carrying a
 *    NON-ZERO weight is a violation (the toggle flips the weight).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeFreshness, parseUtcInstant } from "@roamlink/contracts";
import { evidenceWeight } from "@roamlink/domain-experience";
import {
  AI_SDK_PATTERNS,
  findSdkImports,
  overlayFor,
  readSourceFiles,
  toggleHint,
  violationEnabled,
  type SourceFile,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-012";
const T0 = "2026-01-15T08:30:00.000Z";

function productionSources(): readonly SourceFile[] {
  return readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK)).filter((file) =>
    file.path.includes("/src/"),
  );
}

describe(`${LOCK}: AI is advisory`, () => {
  it("green: no production source imports or depends on an AI/LLM SDK", () => {
    const findings = findSdkImports(productionSources(), AI_SDK_PATTERNS);
    expect(
      findings.map((finding) => `${finding.file} imports ${finding.imported} (${finding.sdk})`),
      `${toggleHint(LOCK)} - advisory tooling must never become an authorizing dependency`,
    ).toEqual([]);
  });

  it("negative proof: a planted AI SDK import is detected (and turns the scan red when toggled)", () => {
    const violating: SourceFile[] = [
      {
        path: "packages/domain-experience/src/ai-advisor.ts",
        content: 'import OpenAI from "openai";\nimport { ChatOpenAI } from "@langchain/openai";\n',
      },
    ];
    const findings = findSdkImports(violating, AI_SDK_PATTERNS);
    expect(findings.map((finding) => finding.sdk).sort()).toEqual(["langchain", "openai"]);

    if (violationEnabled(LOCK)) {
      const real = findSdkImports(productionSources(), AI_SDK_PATTERNS);
      expect(real.length).toBeGreaterThan(0);
    }
  });

  it("green: STALE and UNKNOWN evidence weigh ZERO no matter the recorded class", () => {
    const stale = makeFreshness(
      {
        observedAt: parseUtcInstant(T0),
        receivedAt: parseUtcInstant(T0),
        freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z"),
      },
      parseUtcInstant("2026-01-15T09:00:00.000Z"),
    );
    expect(stale.freshnessState).toBe("STALE");
    for (const evidenceClass of ["AUTHENTICATED", "OBSERVED", "REPORTED", "DERIVED", "INFERRED"]) {
      expect(evidenceWeight(evidenceClass as never, stale)).toBe(0);
    }
    const unknown = makeFreshness({}, parseUtcInstant(T0));
    expect(unknown.freshnessState).toBe("UNKNOWN");
    expect(evidenceWeight("AUTHENTICATED", unknown)).toBe(0);
  });

  it("negative proof: STALE evidence weighing anything is a violation (red when it weighs in)", () => {
    const stale = makeFreshness(
      {
        observedAt: parseUtcInstant(T0),
        receivedAt: parseUtcInstant(T0),
        freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z"),
      },
      parseUtcInstant("2026-01-15T09:00:00.000Z"),
    );
    if (violationEnabled(LOCK)) {
      expect(evidenceWeight("AUTHENTICATED", stale)).toBeGreaterThan(0);
    } else {
      expect(evidenceWeight("AUTHENTICATED", stale)).toBe(0);
    }
  });

  it("green: the advisory decision record has no command/authorization surface", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/domain-experience/src"], []);
    const decision = files.find((file) => file.path.endsWith("experience-decision.ts"));
    expect(decision).toBeDefined();
    const content = decision?.content ?? "";
    // The decision references connectivity; it never authorizes it.
    expect(content).toMatch(/do NOT authorize connectivity|never authorize/);
    for (const forbidden of [
      /CommandEnvelope/,
      /authorize\(/,
      /executeCommand/,
      /connectivityCommand/,
    ]) {
      expect(
        forbidden.test(content),
        `the advisory surface must not carry a command surface (${forbidden})`,
      ).toBe(false);
    }
  });

  it("green: advisory computation is deterministic (pure function of its inputs)", () => {
    const at = parseUtcInstant(T0);
    const fresh = makeFreshness(
      {
        observedAt: at,
        receivedAt: at,
        freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z"),
      },
      at,
    );
    // Same inputs -> same weight, every time (no ambient channel).
    const first = evidenceWeight("OBSERVED", fresh);
    const second = evidenceWeight("OBSERVED", structuredClone(fresh));
    const third = evidenceWeight("OBSERVED", structuredClone(fresh));
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBe(3);
  });
});
