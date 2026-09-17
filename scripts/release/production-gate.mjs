#!/usr/bin/env node
/**
 * RL-081 — the production readiness gate.
 *
 * Runs the MVP release gate FIRST (hard prerequisite: `node
 * scripts/release/mvp-gate.mjs` — its artifact at docs/reports/mvp-gate.json
 * feeds this gate's suite evidence). If the MVP gate fails, the production
 * gate fails: remaining steps are skipped and the exit code is non-zero.
 *
 * Then the production-readiness criteria (beyond MVP):
 *
 *   PRD-1  security/threat verification complete with all negative proofs
 *          green; every recorded finding dispositioned (no open HIGH
 *          findings without an accepted-risk note — enforced for ALL
 *          severities via docs/reports/accepted-risks.json);
 *   PRD-2  deployment/recovery runbook verified (cold start, crash recovery,
 *          backup/restore, dependency-failure modes);
 *   PRD-3  observability: structured logs with correlation IDs end-to-end in
 *          dogfood scenarios; honest health/readiness composition; wired
 *          §11 SLO instrumentation;
 *   PRD-4  docs complete: README quickstart reproduces a local dogfood run
 *          from a clean clone; spec current-state claims consistent with
 *          reality; CHANGELOG drafted for the MVP release;
 *   PRD-5  the accepted-risk registry is valid and its coverage complete.
 *
 * ACCEPTED-RISK MODEL (per the RL-081 contract): a gap that cannot be closed
 * by this worker is recorded as an EXPLICIT accepted-risk line in
 * docs/reports/accepted-risks.json — visible, never hidden. Unmet criterion
 * rows covered by validated registry entries are reported as `gap` rows
 * carrying their risk ids; uncovered failures fail the gate. The registry
 * cannot cover itself (circularity guard).
 *
 * EXIT-FAITHFUL: exit 0 only when the MVP prerequisite passed AND every
 * production criterion has zero uncovered failures; exit 1 otherwise.
 * Machine-readable summary (JSON) on stdout; artifact at
 * docs/reports/production-gate.json.
 *
 * Usage: node scripts/release/production-gate.mjs [--full-report] [--json-only]
 *
 *   --full-report  evaluate the production criteria for EVIDENCE even when
 *                  the MVP prerequisite failed (the verdict is unaffected —
 *                  a failed prerequisite fails the gate regardless). Used to
 *                  produce the complete criteria picture in the verdict
 *                  report; it never converts a failure into a pass.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { commandStep, runGate, stdoutSummary } from "./lib/gate-engine.mjs";
import { readText } from "./lib/gate-util.mjs";
import { evaluateSloInstrumentation } from "./lib/criteria-mvp.mjs";
import {
  ACCEPTED_RISKS_PATH,
  applyAcceptedRiskCoverage,
  evaluateAcceptedRisks,
  evaluateDeploymentRunbook,
  evaluateDocsCompleteness,
  evaluateObservability,
  evaluateSecurityVerification,
  extractRegistryFindings,
  loadAcceptedRiskRegistry,
} from "./lib/criteria-production.mjs";

const repoRoot = process.cwd();
const ARTIFACT_PATH = join(repoRoot, "docs", "reports", "production-gate.json");
const MVP_ARTIFACT_PATH = join(repoRoot, "docs", "reports", "mvp-gate.json");
const fullReport = process.argv.includes("--full-report");
const jsonOnly = process.argv.includes("--json-only");

/** Reads the MVP gate artifact produced by the prerequisite step. */
function readMvpArtifact() {
  const text = readText(MVP_ARTIFACT_PATH);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Suite results from the MVP artifact's test step (feeds PRD criteria). */
function suiteResultsFromMvpArtifact() {
  const artifact = readMvpArtifact();
  const suites = artifact?.steps?.find((step) => step.id === "test")?.details?.suites ?? [];
  return Object.fromEntries(
    suites.map((suite) => [
      suite.package,
      { status: suite.status, exitCode: suite.exitCode, tests: suite.tests },
    ]),
  );
}

/** Recorded findings across the verification docs (for PRD-5 coverage). */
function findingsFromDocs() {
  return extractRegistryFindings(repoRoot);
}

/** The production criteria, evaluated against the MVP artifact's evidence. */
function productionCriteria() {
  const registry = loadAcceptedRiskRegistry(repoRoot);

  const withCoverage = (raw) => {
    if (!registry.ok) {
      // An invalid registry means gaps CANNOT be covered — every unmet row
      // stays a hard failure and PRD-5 reports why.
      return raw;
    }
    return applyAcceptedRiskCoverage(raw, registry.registry).result;
  };

  return [
    {
      id: "PRD-1",
      requirement:
        "Security/threat verification complete with all negative proofs green (RL-074 matrix); every recorded finding dispositioned via the accepted-risk registry — no open HIGH findings without an accepted-risk note (enforced for ALL severities).",
      evaluate: () => withCoverage(evaluateSecurityVerification(repoRoot, suiteResultsFromMvpArtifact())),
    },
    {
      id: "PRD-2",
      requirement:
        "Deployment/recovery runbook verified (RL-075): cold start, crash recovery, backup/restore and dependency-failure modes all proven by green suites and documented.",
      evaluate: () => withCoverage(evaluateDeploymentRunbook(repoRoot, suiteResultsFromMvpArtifact())),
    },
    {
      id: "PRD-3",
      requirement:
        "Observability: structured logs with correlation IDs verified end-to-end in dogfood scenarios; health/readiness composition honest; operational §11 SLO instrumentation wired.",
      evaluate: () => {
        const sloRows = evaluateSloInstrumentation(repoRoot).rows;
        return withCoverage(evaluateObservability(repoRoot, suiteResultsFromMvpArtifact(), sloRows));
      },
    },
    {
      id: "PRD-4",
      requirement:
        "Docs complete: README quickstart reproduces a local dogfood run from a clean clone with copy-paste commands; every spec document's current-state claims consistent with reality; CHANGELOG/release notes drafted for an MVP release.",
      evaluate: () => withCoverage(evaluateDocsCompleteness(repoRoot)),
    },
    {
      id: "PRD-5",
      requirement:
        "The accepted-risk registry is valid (schema, fields, severities, no self-coverage) and its coverage is complete (every finding and every unmet criterion row is explicitly dispositioned).",
      evaluate: () => {
        // PRD-5 evaluates the registry against the OTHER criteria's raw rows
        // (pre-coverage, so orphans/gaps are judged on the literal evidence).
        const rawRows = [
          evaluateSecurityVerification(repoRoot, suiteResultsFromMvpArtifact()),
          evaluateDeploymentRunbook(repoRoot, suiteResultsFromMvpArtifact()),
          evaluateObservability(
            repoRoot,
            suiteResultsFromMvpArtifact(),
            evaluateSloInstrumentation(repoRoot).rows,
          ),
          evaluateDocsCompleteness(repoRoot),
        ];
        return evaluateAcceptedRisks(repoRoot, rawRows, findingsFromDocs());
      },
    },
  ];
}

function gitMeta() {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const dirty = run(["status", "--porcelain"]);
  return {
    commit: run(["rev-parse", "HEAD"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyFiles: dirty === null ? null : dirty.split("\n").filter((line) => line.length > 0).length,
  };
}

const report = runGate({
  gateId: "RL-081",
  title: "RoamLink production readiness gate",
  steps: [
    commandStep({
      id: "mvp-prerequisite",
      label: "RL-080 MVP release gate (hard prerequisite): node scripts/release/mvp-gate.mjs",
      command: ["node", "scripts/release/mvp-gate.mjs", "--json-only"],
      critical: true,
      timeoutMs: 60 * 60 * 1000,
      tailLines: 40,
    }),
  ],
  criteria: productionCriteria(),
  evaluateCriteriaOnStepFailure: fullReport,
  artifactPath: ARTIFACT_PATH,
  repoRoot,
  env: (() => {
    const env = { ...process.env };
    delete env.ROAMLINK_CONFORMANCE_VIOLATION;
    return env;
  })(),
  meta: {
    mvpArtifact: "docs/reports/mvp-gate.json",
    acceptedRisksRegistry: ACCEPTED_RISKS_PATH.split(/[\\/]/).join("/"),
    fullReport,
    git: gitMeta(),
  },
  finalizeReport: (report) => {
    // Embed the MVP prerequisite verdict read from the artifact the
    // prerequisite step just wrote (evaluated AFTER steps, BEFORE emission).
    const mvpArtifact = readMvpArtifact();
    report.mvpGate = mvpArtifact
      ? {
          verdict: mvpArtifact.verdict,
          generatedAt: mvpArtifact.generatedAt,
          artifact: "docs/reports/mvp-gate.json",
        }
      : { verdict: null, artifact: "docs/reports/mvp-gate.json", note: "MVP artifact missing/invalid" };
  },
  logger: jsonOnly ? () => {} : undefined,
});

process.stdout.write(stdoutSummary(report) + "\n");
if (!jsonOnly) {
  console.error(`\nProduction readiness gate verdict: ${report.verdict.status.toUpperCase()} (exit ${report.verdict.exitCode})`);
  console.error(`artifact: docs/reports/production-gate.json`);
  console.error(`MVP prerequisite: ${report.mvpGate.verdict ? report.mvpGate.verdict.status : "unknown"}`);
  if (!existsSync(join(repoRoot, ACCEPTED_RISKS_PATH))) {
    console.error(`  ! accepted-risk registry missing: ${ACCEPTED_RISKS_PATH.split(/[\\/]/).join("/")}`);
  }
  for (const failure of report.verdict.failedCriterionRows) {
    console.error(`  ✗ ${failure}`);
  }
}
process.exit(report.verdict.exitCode);
