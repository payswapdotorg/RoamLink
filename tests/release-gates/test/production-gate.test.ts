/**
 * RL-081 machinery tests: the production readiness gate verifies itself.
 *
 * Drives the REAL production criteria evaluators
 * (scripts/release/lib/criteria-production.mjs) and the REAL engine against
 * the committed fixture trees, with a fake runner, fixed clock and capturing
 * writer:
 *
 *   - accepted-risk registry validation (schema, severities, self-coverage
 *     rejection) and coverage application (fail → disclosed gap, uncovered
 *     failures stay failures);
 *   - PRD-1..PRD-5 evaluator verdicts on the conforming fixture tree and the
 *     violations fixture tree;
 *   - the full production-gate flow: MVP prerequisite as a critical step
 *     (pass → criteria evaluated; fail → short-circuit, verdict unaffected
 *     by --full-report evidence).
 *
 * Determinism: no network, no wall-clock, committed fixtures only.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runGate, stdoutSummary } from "../../../scripts/release/lib/gate-engine.mjs";
import { evaluateSloInstrumentation } from "../../../scripts/release/lib/criteria-mvp.mjs";
import {
  applyAcceptedRiskCoverage,
  evaluateAcceptedRisks,
  evaluateDeploymentRunbook,
  evaluateDocsCompleteness,
  evaluateObservability,
  evaluateSecurityVerification,
  extractRegistryFindings,
  loadAcceptedRiskRegistry,
} from "../../../scripts/release/lib/criteria-production.mjs";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const MINI_REPO = join(FIXTURES, "mini-repo");
const VIOLATIONS_REPO = join(FIXTURES, "mini-repo-violations");

const FIXED_NOW = "2026-01-15T08:30:00.000Z";

/** Green suite results shaped like the MVP gate artifact's test step. */
const FIXTURE_SUITES = {
  "@roamlink/tests-security": { status: "pass", exitCode: 0, tests: { passed: 57, failed: 0, total: 57 } },
  "@roamlink/tests-deployment": { status: "pass", exitCode: 0, tests: { passed: 26, failed: 0, total: 26 } },
};

/** Fake runner for the full-gate-flow fixtures. */
function fakeRunner(exitCodes: Record<string, number> = {}) {
  return (command: readonly string[], _options: unknown) => ({
    command: command.join(" "),
    exitCode: exitCodes[command.join(" ")] ?? 0,
    stdout: "fixture stdout",
    stderr: "",
    durationMs: 3,
    timedOut: false,
  });
}

function capturingWriter() {
  const writes: { path: string; contents: string }[] = [];
  return { writes, writer: (path: string, contents: string) => writes.push({ path, contents }) };
}

/** A criterion result shape loose enough for every evaluator's inferred return. */
interface LooseCriterion {
  id: string;
  requirement: string;
  status: string;
  rows: Array<{ id: string; status: string; summary: string; evidence: string[]; acceptedRiskIds?: string[] }>;
  summary: string;
}

/** Composes the production criteria exactly like the production-gate CLI. */
function productionCriteria(repoRoot: string, suiteResults: Record<string, unknown>): LooseCriterion[] {
  const loaded = loadAcceptedRiskRegistry(repoRoot);
  const registry = loaded.ok && loaded.registry !== null ? loaded.registry : null;
  const withCoverage = (raw: LooseCriterion): LooseCriterion =>
    registry !== null ? applyAcceptedRiskCoverage(raw, registry).result : raw;

  return [
    withCoverage(evaluateSecurityVerification(repoRoot, suiteResults)),
    withCoverage(evaluateDeploymentRunbook(repoRoot, suiteResults)),
    withCoverage(
      evaluateObservability(repoRoot, suiteResults, evaluateSloInstrumentation(repoRoot).rows),
    ),
    withCoverage(evaluateDocsCompleteness(repoRoot)),
    evaluateAcceptedRisks(
      repoRoot,
      [
        evaluateSecurityVerification(repoRoot, suiteResults),
        evaluateDeploymentRunbook(repoRoot, suiteResults),
        evaluateObservability(repoRoot, suiteResults, evaluateSloInstrumentation(repoRoot).rows),
        evaluateDocsCompleteness(repoRoot),
      ],
      extractRegistryFindings(repoRoot),
    ),
  ];
}

describe("RL-081 accepted-risk registry validation (fixtures)", () => {
  it("mini-repo registry is valid with all required fields", () => {
    const { ok, registry, errors } = loadAcceptedRiskRegistry(MINI_REPO);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(registry?.risks).toHaveLength(3);
  });

  it("violations registry is rejected: missing fields, bad severity, self-coverage", () => {
    const { ok, errors } = loadAcceptedRiskRegistry(VIOLATIONS_REPO);
    expect(ok).toBe(false);
    expect(errors.some((error) => error.includes("field \"justification\""))).toBe(true);
    expect(errors.some((error) => error.includes('severity "extreme" outside'))).toBe(true);
    expect(errors.some((error) => error.includes("cannot cover its own criterion"))).toBe(true);
  });

  it("a missing registry is an explicit failure, never a silent pass", () => {
    const { ok, errors } = loadAcceptedRiskRegistry(join(FIXTURES, "no-such-repo"));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("accepted-risks.json not found");
  });
});

describe("RL-081 accepted-risk coverage application (fixtures)", () => {
  it("an unmet row covered by the registry becomes a disclosed gap with risk ids", () => {
    const raw = evaluateObservability(
      MINI_REPO,
      FIXTURE_SUITES,
      evaluateSloInstrumentation(MINI_REPO).rows,
    );
    const failingRow = raw.rows.find((row) => row.id === "OBS:logs-correlation");
    expect(failingRow?.status).toBe("fail");

    const loaded = loadAcceptedRiskRegistry(MINI_REPO);
    if (loaded.registry === null) throw new Error("fixture registry missing");
    const { result, uncovered } = applyAcceptedRiskCoverage(raw, loaded.registry);
    expect(uncovered).toEqual([]);
    const gapRow = result.rows.find((row) => row.id === "OBS:logs-correlation");
    expect(gapRow?.status).toBe("gap");
    expect(gapRow?.acceptedRiskIds).toEqual(["AR-F01"]);
    expect(gapRow?.summary).toContain("UNMET — covered by accepted risk AR-F01");
    expect(result.status).toBe("pass");
    expect(result.summary).toContain("covered by accepted-risk records");
  });

  it("an unmet row WITHOUT a registry entry stays a hard failure", () => {
    const raw = evaluateDocsCompleteness(VIOLATIONS_REPO);
    const loaded = loadAcceptedRiskRegistry(VIOLATIONS_REPO);
    // The violations registry is invalid — coverage is unavailable entirely.
    expect(loaded.ok).toBe(false);
    const { result, uncovered } = applyAcceptedRiskCoverage(
      raw,
      loaded.registry ?? { schema: "none", risks: [] },
    );
    expect(uncovered.length).toBeGreaterThan(0);
    expect(result.status).toBe("fail");
    const quickstart = result.rows.find((row) => row.id === "DOCS:quickstart");
    expect(quickstart?.status).toBe("fail");
  });
});

describe("RL-081 criteria evaluators — security (fixtures)", () => {
  it("mini-repo: suite green, ≥10 verified threats, findings recorded, honest gaps disclosed", () => {
    const result = evaluateSecurityVerification(MINI_REPO, FIXTURE_SUITES);
    expect(result.rows.find((row) => row.id === "SEC:suite")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "SEC:negative-proofs")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "SEC:findings-recorded")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "SEC:honest-gaps")?.status).toBe("gap");
    expect(result.rows.find((row) => row.id === "SEC:honest-gaps")?.summary).toContain("8 documented inherent-infrastructure limit");
  });

  it("violations repo: incomplete matrix fails; a red security suite fails", () => {
    const result = evaluateSecurityVerification(VIOLATIONS_REPO, FIXTURE_SUITES);
    expect(result.rows.find((row) => row.id === "SEC:negative-proofs")?.status).toBe("fail");
    expect(result.status).toBe("fail");

    const redSuite = evaluateSecurityVerification(MINI_REPO, {
      "@roamlink/tests-security": { status: "fail", exitCode: 1 },
    });
    expect(redSuite.rows.find((row) => row.id === "SEC:suite")?.status).toBe("fail");
    expect(redSuite.status).toBe("fail");
  });
});

describe("RL-081 criteria evaluators — deployment runbook (fixtures)", () => {
  it("mini-repo: cold start, crash recovery, backup/restore, dependency failure all verified", () => {
    const result = evaluateDeploymentRunbook(MINI_REPO, FIXTURE_SUITES);
    for (const row of result.rows) {
      expect(row.status).toBe("pass");
    }
    expect(result.status).toBe("pass");
  });

  it("violations repo: missing suite files and runbook keywords fail", () => {
    const result = evaluateDeploymentRunbook(VIOLATIONS_REPO, FIXTURE_SUITES);
    expect(result.rows.find((row) => row.id === "DEPLOY:cold-start")?.status).toBe("fail");
    expect(result.rows.find((row) => row.id === "DEPLOY:backup-restore")?.status).toBe("fail");
    expect(result.status).toBe("fail");
  });
});

describe("RL-081 criteria evaluators — observability (fixtures)", () => {
  it("mini-repo: honest health passes; logging wiring and SLO wiring are unmet (coverable gaps)", () => {
    const result = evaluateObservability(
      MINI_REPO,
      FIXTURE_SUITES,
      evaluateSloInstrumentation(MINI_REPO).rows,
    );
    expect(result.rows.find((row) => row.id === "OBS:logs-correlation")?.status).toBe("fail");
    expect(result.rows.find((row) => row.id === "OBS:health-readiness")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "OBS:slo-wiring")?.status).toBe("fail");
    expect(result.status).toBe("fail");
  });
});

describe("RL-081 criteria evaluators — docs completeness (fixtures)", () => {
  it("mini-repo: quickstart, current-state and changelog all pass", () => {
    const result = evaluateDocsCompleteness(MINI_REPO);
    expect(result.rows.find((row) => row.id === "DOCS:quickstart")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "DOCS:current-state")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "DOCS:changelog")?.status).toBe("pass");
    expect(result.status).toBe("pass");
  });

  it("violations repo: no quickstart, stale current-state claims, no changelog", () => {
    const result = evaluateDocsCompleteness(VIOLATIONS_REPO);
    expect(result.rows.find((row) => row.id === "DOCS:quickstart")?.status).toBe("fail");
    const currentState = result.rows.find((row) => row.id === "DOCS:current-state");
    expect(currentState?.status).toBe("fail");
    expect(currentState?.summary).toContain("no production feature implementation started");
    expect(currentState?.summary).toContain("greenfield");
    expect(result.rows.find((row) => row.id === "DOCS:changelog")?.status).toBe("fail");
    expect(result.status).toBe("fail");
  });
});

describe("RL-081 criteria evaluators — registry coverage (fixtures)", () => {
  it("mini-repo: findings collected, coverage complete, high risks dispositioned", () => {
    expect(extractRegistryFindings(MINI_REPO)).toEqual([
      "RL-073-DEFECT-1",
      "RL-074-F1",
      "RL-075-F1",
    ]);
    const criteria = [
      evaluateSecurityVerification(MINI_REPO, FIXTURE_SUITES),
      evaluateDeploymentRunbook(MINI_REPO, FIXTURE_SUITES),
      evaluateObservability(MINI_REPO, FIXTURE_SUITES, evaluateSloInstrumentation(MINI_REPO).rows),
      evaluateDocsCompleteness(MINI_REPO),
    ];
    const result = evaluateAcceptedRisks(MINI_REPO, criteria, extractRegistryFindings(MINI_REPO));
    expect(result.rows.find((row) => row.id === "RISK:registry")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "RISK:no-orphans")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "RISK:findings-coverage")?.status).toBe("pass");
    expect(result.rows.find((row) => row.id === "RISK:high-disposition")?.status).toBe("pass");
    expect(result.status).toBe("pass");
  });

  it("violations repo: invalid registry fails PRD-5 outright", () => {
    const criteria = [
      evaluateSecurityVerification(VIOLATIONS_REPO, FIXTURE_SUITES),
      evaluateDeploymentRunbook(VIOLATIONS_REPO, FIXTURE_SUITES),
      evaluateObservability(VIOLATIONS_REPO, FIXTURE_SUITES, evaluateSloInstrumentation(VIOLATIONS_REPO).rows),
      evaluateDocsCompleteness(VIOLATIONS_REPO),
    ];
    const result = evaluateAcceptedRisks(VIOLATIONS_REPO, criteria, extractRegistryFindings(VIOLATIONS_REPO));
    expect(result.status).toBe("fail");
    expect(result.rows.find((row) => row.id === "RISK:registry")?.status).toBe("fail");
    expect(result.summary).toContain("registry invalid");
  });
});

describe("RL-081 full production-gate flow (fixtures)", () => {
  it("a passing MVP prerequisite + covered gaps = pass with explicit accepted risks", () => {
    const { writes, writer } = capturingWriter();
    const criteria = productionCriteria(MINI_REPO, FIXTURE_SUITES);
    const report = runGate({
      gateId: "RL-081",
      title: "fixture production gate",
      steps: [
        {
          id: "mvp-prerequisite",
          label: "fixture MVP gate",
          critical: true,
          execute: () => ({
            id: "mvp-prerequisite",
            label: "fixture MVP gate",
            status: "pass",
            exitCode: 0,
            summary: "fixture MVP gate passed",
          }),
        },
      ],
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        requirement: criterion.requirement,
        evaluate: () => criterion,
      })),
      artifactPath: "/tmp/fixture-production-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("pass");
    expect(report.verdict.exitCode).toBe(0);
    expect(report.verdict.acceptedRisks).toEqual(["AR-F01", "AR-F02", "AR-F03"]);
    expect(report.criteria.map((criterion) => criterion.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    // The gaps stay visible in the artifact rows — never silent passes.
    const gapRows = report.criteria.flatMap((criterion) =>
      criterion.rows.filter((row) => row.status === "gap").map((row) => row.id),
    );
    expect(gapRows).toEqual(["SEC:honest-gaps", "OBS:logs-correlation", "OBS:slo-wiring"]);
    const parsed = JSON.parse(stdoutSummary(report)) as { acceptedRisks: string[] };
    expect(parsed.acceptedRisks).toEqual(["AR-F01", "AR-F02", "AR-F03"]);
    expect(writes).toHaveLength(1);
  });

  it("a FAILING MVP prerequisite short-circuits and fails the gate regardless of criteria", () => {
    const report = runGate({
      gateId: "RL-081",
      title: "fixture production gate",
      steps: [
        {
          id: "mvp-prerequisite",
          label: "fixture MVP gate",
          critical: true,
          execute: () => ({
            id: "mvp-prerequisite",
            label: "fixture MVP gate",
            status: "fail",
            exitCode: 1,
            summary: "fixture MVP gate FAILED",
          }),
        },
      ],
      criteria: productionCriteria(MINI_REPO, FIXTURE_SUITES).map((criterion) => ({
        id: criterion.id,
        requirement: criterion.requirement,
        evaluate: () => criterion,
      })),
      artifactPath: "/tmp/fixture-production-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.exitCode).toBe(1);
    expect(report.verdict.failedSteps).toEqual(["mvp-prerequisite"]);
    // Criteria not evaluated on prerequisite failure by default.
    expect(report.criteria[0]?.summary).toContain("not evaluated");
  });

  it("--full-report (evaluateCriteriaOnStepFailure) produces evidence without rescuing the verdict", () => {
    const criteria = productionCriteria(MINI_REPO, FIXTURE_SUITES);
    const report = runGate({
      gateId: "RL-081",
      title: "fixture production gate",
      steps: [
        {
          id: "mvp-prerequisite",
          label: "fixture MVP gate",
          critical: true,
          execute: () => ({
            id: "mvp-prerequisite",
            label: "fixture MVP gate",
            status: "fail",
            exitCode: 1,
            summary: "fixture MVP gate FAILED",
          }),
        },
      ],
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        requirement: criterion.requirement,
        evaluate: () => criterion,
      })),
      evaluateCriteriaOnStepFailure: true,
      artifactPath: "/tmp/fixture-production-gate.json",
      repoRoot: MINI_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.failedSteps).toEqual(["mvp-prerequisite"]);
    // Evidence IS produced (criteria evaluated)…
    expect(report.criteria.map((criterion) => criterion.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    // …but the verdict still fails: the prerequisite is a hard gate.
    expect(report.verdict.exitCode).toBe(1);
  });

  it("the violations fixture tree fails the production gate with uncovered failures", () => {
    const criteria = productionCriteria(VIOLATIONS_REPO, FIXTURE_SUITES);
    const report = runGate({
      gateId: "RL-081",
      title: "fixture production gate",
      steps: [
        {
          id: "mvp-prerequisite",
          label: "fixture MVP gate",
          critical: true,
          execute: () => ({
            id: "mvp-prerequisite",
            label: "fixture MVP gate",
            status: "pass",
            exitCode: 0,
            summary: "fixture MVP gate passed",
          }),
        },
      ],
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        requirement: criterion.requirement,
        evaluate: () => criterion,
      })),
      artifactPath: "/tmp/fixture-production-gate.json",
      repoRoot: VIOLATIONS_REPO,
      runner: fakeRunner(),
      now: () => FIXED_NOW,
      writer: capturingWriter().writer,
      logger: () => {},
    });
    expect(report.verdict.status).toBe("fail");
    expect(report.verdict.exitCode).toBe(1);
    expect(report.verdict.failedCriteria).toEqual(["PRD-1", "PRD-2", "PRD-3", "PRD-4", "PRD-5"]);
    expect(report.verdict.acceptedRisks).toEqual([]);
  });
});
