/**
 * RL-080 machinery tests: the MVP release gate verifies itself.
 *
 * These tests drive the REAL gate engine (scripts/release/lib/gate-engine.mjs)
 * and the REAL criteria evaluators (gate-util.mjs, work-items.mjs,
 * criteria-mvp.mjs) against COMMITTED FIXTURE TREES (fixtures/mini-repo,
 * fixtures/mini-repo-violations) with an injected fake command runner, a
 * fixed clock and a capturing artifact writer:
 *
 *   - aggregation: verdicts, failed-step/criterion/row lists, accepted-risk
 *     roll-up, stdout summary shape;
 *   - failure propagation: critical step failure short-circuits the
 *     remaining steps and fails the gate — never converts a failure;
 *   - artifact emission: docs/reports/<gate>.json contents parse and mirror
 *     the report; a throwing writer fails the gate;
 *   - evaluator correctness: work-item representation, lock coverage, §11
 *     SLO instrumentation (comment-exclusion included), API consistency.
 *
 * Determinism: no network, no wall-clock (fixed injected clock), no ambient
 * randomness; fixture trees are committed read-only data.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  commandStep,
  defaultWriter,
  runGate,
  stdoutSummary,
} from "../../../scripts/release/lib/gate-engine.mjs";
import {
  extractBashBlocks,
  extractFindingIds,
  parseSpecApiResources,
  parseSpecSlos,
  parseVitestSummary,
  sloSlug,
  stripComments,
} from "../../../scripts/release/lib/gate-util.mjs";
import {
  evaluateApiConsistency,
  evaluateLockCoverage,
  evaluateSloInstrumentation,
} from "../../../scripts/release/lib/criteria-mvp.mjs";
import { evaluateWorkItems } from "../../../scripts/release/lib/work-items.mjs";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const MINI_REPO = join(FIXTURES, "mini-repo");
const VIOLATIONS_REPO = join(FIXTURES, "mini-repo-violations");

const FIXED_NOW = "2026-01-15T08:30:00.000Z";

/** A canned, deterministic command runner. */
function fakeRunner(results: Record<string, { exitCode?: number; stdout?: string; stderr?: string }> = {}) {
  return (command: readonly string[], _options: unknown) => ({
    command: command.join(" "),
    exitCode: results[command.join(" ")]?.exitCode ?? 0,
    stdout: results[command.join(" ")]?.stdout ?? "fake stdout",
    stderr: results[command.join(" ")]?.stderr ?? "",
    durationMs: 7,
    timedOut: false,
  });
}

/** A capturing artifact writer. */
function capturingWriter() {
  const writes: { path: string; contents: string }[] = [];
  return {
    writes,
    writer: (path: string, contents: string) => {
      writes.push({ path, contents });
    },
  };
}

interface FixtureRow {
  id: string;
  status: "pass" | "fail" | "gap";
  summary: string;
  evidence: string[];
  acceptedRiskIds?: string[];
}

interface FixtureCriterionResult {
  id: string;
  requirement: string;
  status: "pass" | "fail";
  rows: FixtureRow[];
  summary: string;
}

interface FixtureCriterion {
  id: string;
  requirement: string;
  evaluate: () => FixtureCriterionResult;
}

/** A step that always passes. */
function passStep(id: string, label = id) {
  return {
    id,
    label,
    execute: () => ({ id, label, status: "pass" as const, summary: "fixture pass" }),
  };
}

/** A step that always fails. */
function failStep(id: string, label = id) {
  return {
    id,
    label,
    execute: () => ({ id, label, status: "fail" as const, summary: "fixture failure" }),
  };
}

/** A criterion that always passes. */
function passCriterion(id: string): FixtureCriterion {
  return {
    id,
    requirement: `fixture requirement ${id}`,
    evaluate: () => ({
      id,
      requirement: `fixture requirement ${id}`,
      status: "pass",
      rows: [{ id: `${id}-row`, status: "pass", summary: "row met", evidence: ["fixture"] }],
      summary: "all rows met",
    }),
  };
}

/** A criterion with one failing row (optionally covered by an accepted risk). */
function mixedCriterion(id: string, rowId: string, acceptedRiskIds?: string[]): FixtureCriterion {
  return {
    id,
    requirement: `fixture requirement ${id}`,
    evaluate: () => ({
      id,
      requirement: `fixture requirement ${id}`,
      status: acceptedRiskIds ? "pass" : "fail",
      rows: [
        { id: `${id}-ok`, status: "pass", summary: "row met", evidence: ["fixture"] },
        acceptedRiskIds
          ? { id: rowId, status: "gap", summary: "unmet, covered", evidence: ["fixture"], acceptedRiskIds }
          : { id: rowId, status: "fail", summary: "row unmet, uncovered", evidence: ["fixture"] },
      ],
      summary: acceptedRiskIds ? "one unmet row covered by accepted risks" : "one uncovered failing row",
    }),
  };
}

describe("RL-080 gate engine — aggregation", () => {
  it("passes with exit 0 only when every step and criterion passes", () => {
    const { writes, writer } = capturingWriter();
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one"), passStep("two")],
      criteria: [passCriterion("C-1"), passCriterion("C-2")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("pass");
    expect(report.verdict.exitCode).toBe(0);
    expect(report.verdict.failedSteps).toEqual([]);
    expect(report.verdict.failedCriteria).toEqual([]);
    expect(report.verdict.failedCriterionRows).toEqual([]);
    expect(report.verdict.acceptedRisks).toEqual([]);
    expect(report.generatedAt).toBe(FIXED_NOW);
    expect(report.steps.map((step) => step.status)).toEqual(["pass", "pass"]);
    expect(report.criteria.map((criterion) => criterion.status)).toEqual(["pass", "pass"]);
    expect(writes).toHaveLength(1);
  });

  it("fails with exit 1 when any criterion row fails, listing the exact rows", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [passCriterion("C-1"), mixedCriterion("C-2", "C-2-bad")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.exitCode).toBe(1);
    expect(report.verdict.failedCriteria).toEqual(["C-2"]);
    expect(report.verdict.failedCriterionRows).toEqual(["C-2/C-2-bad"]);
  });

  it("rolls accepted-risk ids up from gap rows without letting them fail the verdict", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [mixedCriterion("C-3", "C-3-gap", ["AR-1", "AR-2"]), passCriterion("C-4")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("pass");
    expect(report.verdict.exitCode).toBe(0);
    expect(report.verdict.failedCriterionRows).toEqual([]);
    expect(report.verdict.acceptedRisks).toEqual(["AR-1", "AR-2"]);
    const summary = stdoutSummary(report);
    const parsed = JSON.parse(summary) as { acceptedRisks: string[]; verdict: { status: string } };
    expect(parsed.verdict.status).toBe("pass");
    expect(parsed.acceptedRisks).toEqual(["AR-1", "AR-2"]);
  });

  it("stdout summary is a single parseable JSON document mirroring the verdict", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [mixedCriterion("C-5", "C-5-bad")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    const parsed = JSON.parse(stdoutSummary(report)) as {
      gate: string;
      verdict: { status: string; failedCriterionRows: string[] };
      steps: { id: string; status: string }[];
      criteria: { id: string; status: string; failedRows: { id: string; status: string }[] }[];
    };
    expect(parsed.gate).toBe("FIXTURE-GATE");
    expect(parsed.verdict.status).toBe("fail");
    expect(parsed.verdict.failedCriterionRows).toEqual(["C-5/C-5-bad"]);
    expect(parsed.steps).toEqual([{ id: "one", status: "pass" }]);
    expect(parsed.criteria[0]?.failedRows.map((row) => row.id)).toEqual(["C-5-bad"]);
  });
});

describe("RL-080 gate engine — failure propagation", () => {
  it("a critical step failure skips remaining steps and fails the gate", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [
        passStep("first"),
        { ...failStep("second"), critical: true },
        passStep("third"),
      ],
      criteria: [passCriterion("C-1")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.exitCode).toBe(1);
    expect(report.verdict.failedSteps).toEqual(["second"]);
    expect(report.steps.map((step) => step.status)).toEqual(["pass", "fail", "skipped"]);
    expect(report.steps[2]?.summary).toContain("skipped");
    // Criteria depend on a green stack: not evaluated, recorded as failures.
    expect(report.criteria[0]?.status).toBe("fail");
    expect(report.criteria[0]?.summary).toContain("not evaluated");
  });

  it("a NON-critical step failure does not skip later steps but still fails the gate", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [failStep("first"), passStep("second")],
      criteria: [passCriterion("C-1")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.steps.map((step) => step.status)).toEqual(["fail", "pass"]);
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.failedSteps).toEqual(["first"]);
  });

  it("a step that throws becomes a recorded failure, not a crash", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [
        {
          id: "throws",
          label: "throws",
          execute: () => {
            throw new Error("fixture explosion");
          },
        },
      ],
      criteria: [],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.steps[0]?.summary).toContain("fixture explosion");
  });

  it("evaluateCriteriaOnStepFailure produces evidence without changing the verdict (diagnostics mode)", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [{ ...failStep("prerequisite"), critical: true }],
      criteria: [passCriterion("C-1")],
      evaluateCriteriaOnStepFailure: true,
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.failedSteps).toEqual(["prerequisite"]);
    expect(report.criteria[0]?.status).toBe("pass");
  });

  it("commandStep maps the runner exit code to pass/fail and captures the output tail", () => {
    const step = commandStep({
      id: "cmd",
      label: "fixture command",
      command: ["pnpm", "test"],
      tailLines: 3,
    });
    const ctx = {
      command: fakeRunner({ "pnpm test": { exitCode: 1, stdout: "line1\nline2\nline3\nline4\nline5" } }),
      repoRoot: MINI_REPO,
      env: {},
      log: () => {},
    };
    const result = step.execute(ctx);
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.outputTail).toEqual(["line3", "line4", "line5"]);

    const ctxOk = {
      command: fakeRunner({ "pnpm test": { exitCode: 0 } }),
      repoRoot: MINI_REPO,
      env: {},
      log: () => {},
    };
    expect(step.execute(ctxOk).status).toBe("pass");
  });
});

describe("RL-080 gate engine — artifact emission", () => {
  it("writes the full report as JSON to the artifact path", () => {
    const { writes, writer } = capturingWriter();
    runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [mixedCriterion("C-6", "C-6-gap", ["AR-9"])],
      artifactPath: "/tmp/fixture-artifact.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer,
      logger: () => {},
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/fixture-artifact.json");
    const artifact = JSON.parse(writes[0]?.contents ?? "{}") as {
      schema: string;
      gate: string;
      verdict: { status: string; acceptedRisks: string[] };
      criteria: { id: string; rows: { status: string; acceptedRiskIds?: string[] }[] }[];
    };
    expect(artifact.schema).toBe("roamlink/release-gate@1");
    expect(artifact.gate).toBe("FIXTURE-GATE");
    expect(artifact.verdict.status).toBe("pass");
    expect(artifact.verdict.acceptedRisks).toEqual(["AR-9"]);
    expect(artifact.criteria[0]?.rows.find((row) => row.status === "gap")?.acceptedRiskIds).toEqual(["AR-9"]);
  });

  it("a throwing writer fails the gate and records the artifact error", () => {
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [passCriterion("C-1")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: () => {
        throw new Error("disk on fire");
      },
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.exitCode).toBe(1);
    expect(report.artifactError).toContain("disk on fire");
  });

  it("finalizeReport enriches the report before artifact emission; a throwing finalizer never rescues the verdict", () => {
    const { writes, writer } = capturingWriter();
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [passCriterion("C-1")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer,
      logger: () => {},
      finalizeReport: (draft) => {
        draft.embedded = { prerequisite: "pass" };
      },
    });
    expect(report.verdict.status).toBe("pass");
    const artifact = JSON.parse(writes[0]?.contents ?? "{}") as { embedded?: { prerequisite: string } };
    expect(artifact.embedded).toEqual({ prerequisite: "pass" });

    const throwing = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [passCriterion("C-1")],
      artifactPath: "/tmp/fixture-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
      finalizeReport: () => {
        throw new Error("finalizer explosion");
      },
    });
    expect(throwing.verdict.status).toBe("pass");
  });

  it("the default writer creates parent directories and writes the artifact", () => {
    const target = join(MINI_REPO, "docs", "reports", "tmp-fixture-gate.json");
    const report = runGate({
      gateId: "FIXTURE-GATE",
      title: "fixture gate",
      steps: [passStep("one")],
      criteria: [],
      artifactPath: target,
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: defaultWriter,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("pass");
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).gate).toBe("FIXTURE-GATE");
  });
});

describe("RL-080 criteria evaluators — work items (fixtures)", () => {
  const manifest = [
    {
      id: "RL-001",
      title: "fixture foundation",
      paths: ["packages/demo/src/index.ts"],
      suites: ["@fixture/demo"],
    },
    {
      id: "RL-002",
      title: "fixture missing item",
      paths: ["packages/demo/src/missing.ts"],
      suites: ["@fixture/demo"],
    },
  ];
  const greenSuites = { "@fixture/demo": { status: "pass", tests: { passed: 3, failed: 0, total: 3 } } };

  it("represents items whose paths exist with green owning suites", () => {
    const result = evaluateWorkItems(MINI_REPO, greenSuites, manifest);
    expect(result.id).toBe("MVP-1");
    expect(result.rows.find((row) => row.id === "RL-001")?.status).toBe("pass");
  });

  it("fails items with missing paths and red/absent suites", () => {
    const result = evaluateWorkItems(MINI_REPO, greenSuites, manifest);
    const missing = result.rows.find((row) => row.id === "RL-002");
    expect(missing?.status).toBe("fail");
    expect(missing?.summary).toContain("missing");

    const redResult = evaluateWorkItems(
      MINI_REPO,
      { "@fixture/demo": { status: "fail", exitCode: 1, tests: { passed: 2, failed: 1, total: 3 } } },
      manifest,
    );
    expect(redResult.rows.find((row) => row.id === "RL-001")?.status).toBe("fail");
    expect(redResult.status).toBe("fail");
  });
});

describe("RL-080 criteria evaluators — lock coverage (fixtures)", () => {
  const coverage = {
    "RL-LOCK-001": {
      suites: ["tests/conformance/test/lock-001-demo.test.ts"],
      package: "@fixture/tests-conformance",
    },
    "RL-LOCK-002": {
      suites: ["tests/conformance/test/lock-002-missing.test.ts"],
      package: "@fixture/tests-conformance",
    },
  };
  const greenSuites = { "@fixture/tests-conformance": { status: "pass", tests: { passed: 4, failed: 0, total: 4 } } };

  it("covers locks whose suite files exist, reference the lock id, and ran green", () => {
    const result = evaluateLockCoverage(MINI_REPO, greenSuites, coverage);
    expect(result.rows.find((row) => row.id === "RL-LOCK-001")?.status).toBe("pass");
  });

  it("fails locks with missing suite files or non-green owning packages", () => {
    const result = evaluateLockCoverage(MINI_REPO, greenSuites, coverage);
    expect(result.rows.find((row) => row.id === "RL-LOCK-002")?.status).toBe("fail");
    const redResult = evaluateLockCoverage(
      MINI_REPO,
      { "@fixture/tests-conformance": { status: "fail" } },
      coverage,
    );
    expect(redResult.rows.find((row) => row.id === "RL-LOCK-001")?.status).toBe("fail");
    expect(redResult.status).toBe("fail");
  });
});

describe("RL-080 criteria evaluators — §11 SLO instrumentation (fixtures)", () => {
  it("mini-repo: an instrumented AND dogfood-referenced SLO passes; an unreferenced one fails", () => {
    const result = evaluateSloInstrumentation(MINI_REPO);
    expect(result.rows.map((row) => row.id)).toEqual([
      "SLO:time-to-usable-connectivity",
      "SLO:intent-satisfaction-rate",
    ]);
    const usable = result.rows[0];
    expect(usable?.status).toBe("pass");
    expect(usable?.summary).toContain("instrumentation: 2 hit");
    expect(usable?.summary).toContain("dogfood/load assertion referencing it: 1 hit");
    const satisfaction = result.rows[1];
    expect(satisfaction?.status).toBe("fail");
    expect(satisfaction?.summary).toContain("NONE in tree code");
    expect(satisfaction?.summary).toContain("dogfood/load assertion referencing it: NONE");
    expect(result.status).toBe("fail");
  });

  it("violations repo: a comment is NOT an assertion — the SLO fails with no references", () => {
    const result = evaluateSloInstrumentation(VIOLATIONS_REPO);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.status).toBe("fail");
    // The dogfood fixture mentions the SLO name only inside a comment.
    expect(row?.evidence.some((line) => line.includes("no tests/dogfood"))).toBe(true);
  });

  it("a missing §11 refuses to pass silently", () => {
    const result = evaluateSloInstrumentation(join(FIXTURES, "no-such-repo"));
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("could not be parsed");
  });
});

describe("RL-080 criteria evaluators — API consistency (fixtures)", () => {
  it("mini-repo: spec resources, stages, envelope and webhooks all consistent", () => {
    const result = evaluateApiConsistency(MINI_REPO);
    expect(result.rows.find((row) => row.id === "API:/v1/users")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "API:/v1/orders")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "API:mutation-stages")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "API:command-envelope")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "API:customer-webhooks")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "API:additive-routes")?.status).toBe("pass");
    expect(result.status).toBe("pass");
  });

  it("violations repo: undocumented resource, missing stage, envelope and webhook contract all fail", () => {
    const result = evaluateApiConsistency(VIOLATIONS_REPO);
    expect(result.rows.find((row) => row.id === "API:/v1/payments")?.status).toBe("fail");
    expect(result.rows.find((row) => row.id === "API:mutation-stages")?.status).toBe("fail");
    expect(result.rows.find((row) => row.id === "API:command-envelope")?.status).toBe("fail");
    expect(result.rows.find((row) => row.id === "API:customer-webhooks")?.status).toBe("fail");
    expect(result.status).toBe("fail");
  });
});

describe("RL-080 gate utilities (fixtures)", () => {
  it("parses vitest pass and fail summaries into exact counts", () => {
    const pass = parseVitestSummary(readFileSync(join(FIXTURES, "vitest-summary-pass.txt"), "utf8"));
    expect(pass).toEqual({
      testFiles: { passed: 2, failed: 0, total: 2 },
      tests: { passed: 5, failed: 0, total: 5 },
    });
    const fail = parseVitestSummary(readFileSync(join(FIXTURES, "vitest-summary-fail.txt"), "utf8"));
    expect(fail).toEqual({
      testFiles: { passed: 1, failed: 1, total: 2 },
      tests: { passed: 3, failed: 2, total: 5 },
    });
    expect(parseVitestSummary("no summary here")).toEqual({
      testFiles: { passed: 0, failed: 0, total: 0 },
      tests: { passed: 0, failed: 0, total: 0 },
    });
  });

  it("strips line and block comments but preserves strings", () => {
    const source = [
      "// line comment with time_to_usable_connectivity",
      "const a = \"time_to_usable_connectivity\";",
      "/* block comment with intent_satisfaction_rate */",
      "const b = 1; // trailing",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).toContain('const a = "time_to_usable_connectivity";');
    expect(stripped).not.toContain("line comment with");
    expect(stripped).not.toContain("block comment with");
    expect(stripped).toContain("const b = 1;");
  });

  it("canonicalizes §11 phrases to slugs", () => {
    expect(sloSlug("time to usable connectivity")).toBe("time-to-usable-connectivity");
    expect(sloSlug("connectivity cost per useful hour/GB where available")).toBe(
      "connectivity-cost-per-useful-hour-gb-where-available",
    );
    expect(sloSlug("manual interventions per session/day")).toBe("manual-interventions-per-session-day");
  });

  it("parses §11 SLOs and spec/api.md resources from the fixture spec", () => {
    expect(parseSpecSlos(MINI_REPO)).toEqual(["time to usable connectivity", "intent satisfaction rate"]);
    expect(parseSpecApiResources(MINI_REPO)).toEqual(["/v1/orders", "/v1/users"]);
    expect(parseSpecSlos(VIOLATIONS_REPO)).toEqual(["time to usable connectivity"]);
  });

  it("extracts bash blocks and validates quickstart command shapes", () => {
    const readme = readFileSync(join(MINI_REPO, "README.md"), "utf8");
    const blocks = extractBashBlocks(readme);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("pnpm install");
    expect(blocks[0]).toContain("pnpm -C tests/dogfood test");
    expect(extractBashBlocks(readme.replace(/```bash[\s\S]*?```/, ""))).toHaveLength(0);
  });

  it("extracts finding ids from verification documents", () => {
    const threat = readFileSync(join(MINI_REPO, "docs", "threat-model-verification.md"), "utf8");
    expect(extractFindingIds(threat)).toEqual(["RL-074-F1"]);
    const deployment = readFileSync(join(MINI_REPO, "docs", "deployment-recovery.md"), "utf8");
    expect(extractFindingIds(deployment)).toEqual(["RL-075-F1"]);
    const load = readFileSync(join(MINI_REPO, "tests", "load", "README.md"), "utf8");
    expect(extractFindingIds(load)).toEqual(["RL-073-DEFECT-1"]);
  });
});
