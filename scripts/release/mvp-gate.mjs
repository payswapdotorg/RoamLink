#!/usr/bin/env node
/**
 * RL-080 — the MVP release gate.
 *
 * One command runs the full verification stack in dependency order and
 * aggregates the MVP pass criteria:
 *
 *   1. install (pnpm install --frozen-lockfile)
 *   2. lint    (pnpm lint — every workspace package)
 *   3. typecheck (pnpm typecheck — every workspace package)
 *   4. test    (EVERY workspace suite, one package at a time, with per-suite
 *               counts parsed from the vitest summaries)
 *   5. architecture:check (the frozen sanity script)
 *
 * then evaluates the criteria from spec/definition-of-done.md applied
 * repo-wide:
 *
 *   MVP-1  every work item RL-001..RL-075 represented with tests green;
 *   MVP-2  every architecture lock RL-LOCK-001..020 covered by conformance
 *          suites;
 *   MVP-3  every SLO in spec/architecture.md §11 instrumented by
 *          observability primitives with at least one dogfood/load
 *          assertion referencing it;
 *   MVP-4  every public API surface documented in spec/api.md consistent
 *          with the actual exported contracts.
 *
 * EXIT-FAITHFUL: exit 0 only on full pass; ANY step or criterion failure
 * exits 1. Machine-readable summary (JSON) on stdout; full artifact at
 * docs/reports/mvp-gate.json. The MVP gate has NO accepted-risk mechanism
 * by design: a failing criterion is a finding for the Tech Lead.
 *
 * Usage: node scripts/release/mvp-gate.mjs [--json-only]
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { commandStep, runGate, stdoutSummary } from "./lib/gate-engine.mjs";
import { discoverWorkspacePackages, parseVitestSummary } from "./lib/gate-util.mjs";
import { evaluateApiConsistency, evaluateLockCoverage, evaluateSloInstrumentation } from "./lib/criteria-mvp.mjs";
import { evaluateWorkItems } from "./lib/work-items.mjs";

const repoRoot = process.cwd();
const ARTIFACT_PATH = join(repoRoot, "docs", "reports", "mvp-gate.json");
const jsonOnly = process.argv.includes("--json-only");

/** Git provenance for the artifact (best effort; gates never depend on it). */
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

/**
 * The test step: every workspace package declaring a `test` script runs it
 * (alphabetical package order — deterministic; the suites are independent
 * after install). Per-suite vitest summaries are parsed into counts so the
 * criteria and the verdict report have exact evidence.
 */
function testSuiteStep() {
  return {
    id: "test",
    label: "every workspace test suite (vitest, per package)",
    critical: true,
    execute: (ctx) => {
      const packages = discoverWorkspacePackages(ctx.repoRoot).filter((pkg) => pkg.hasTest);
      const suites = [];
      for (const pkg of packages) {
        ctx.log(`  · ${pkg.name}`);
        const result = ctx.command(["pnpm", "test"], { cwd: join(ctx.repoRoot, pkg.dir), env: ctx.env, timeoutMs: 15 * 60 * 1000 });
        const summary = parseVitestSummary(`${result.stdout}\n${result.stderr}`);
        suites.push({
          package: pkg.name,
          dir: pkg.dir,
          status: result.exitCode === 0 ? "pass" : "fail",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          tests: summary.tests,
          testFiles: summary.testFiles,
        });
      }
      const failed = suites.filter((suite) => suite.status !== "pass");
      const totalTests = suites.reduce((sum, suite) => sum + (suite.tests.total ?? 0), 0);
      const passedTests = suites.reduce((sum, suite) => sum + (suite.tests.passed ?? 0), 0);
      const durationMs = suites.reduce((sum, suite) => sum + (suite.durationMs ?? 0), 0);
      return {
        id: "test",
        label: `every workspace test suite (${suites.length} suites)`,
        status: failed.length === 0 && suites.length > 0 ? "pass" : "fail",
        durationMs,
        summary:
          suites.length === 0
            ? "no workspace package declares a test script"
            : failed.length === 0
              ? `${suites.length} suites green — ${passedTests}/${totalTests} tests`
              : `${failed.length}/${suites.length} suites FAILED: ${failed.map((suite) => suite.package).join(", ")}`,
        details: { suites },
      };
    },
  };
}

const gate = {
  gateId: "RL-080",
  title: "RoamLink MVP release gate",
  steps: [
    commandStep({
      id: "install",
      label: "pnpm install --frozen-lockfile",
      command: ["pnpm", "install", "--frozen-lockfile"],
      critical: true,
      timeoutMs: 10 * 60 * 1000,
      tailLines: 8,
    }),
    commandStep({
      id: "lint",
      label: "pnpm lint (every workspace package)",
      command: ["pnpm", "lint"],
      timeoutMs: 10 * 60 * 1000,
      tailLines: 8,
    }),
    commandStep({
      id: "typecheck",
      label: "pnpm typecheck (every workspace package)",
      command: ["pnpm", "typecheck"],
      timeoutMs: 10 * 60 * 1000,
      tailLines: 8,
    }),
    testSuiteStep(),
    commandStep({
      id: "architecture",
      label: "node scripts/check-architecture.mjs (frozen sanity script)",
      command: ["node", "scripts/check-architecture.mjs"],
      timeoutMs: 5 * 60 * 1000,
      tailLines: 8,
    }),
  ],
};

// The criteria closures need the test step's suite results, which only exist
// after the steps run. runGate evaluates criteria strictly AFTER all steps,
// so we record each completed step result in a side channel the criteria
// read at evaluation time.
const completedSteps = [];
const suiteResults = () => {
  const testStep = completedSteps.find((step) => step.id === "test");
  const suites = testStep?.details?.suites ?? [];
  return Object.fromEntries(
    suites.map((suite) => [
      suite.package,
      { status: suite.status, exitCode: suite.exitCode, tests: suite.tests },
    ]),
  );
};

const criteria = [
  {
    id: "MVP-1",
    requirement:
      "Every work item RL-001..RL-075 is represented on main (its packages/suites/docs exist) with tests green (owning suites passed in the gate's test step).",
    evaluate: () => evaluateWorkItems(repoRoot, suiteResults()),
  },
  {
    id: "MVP-2",
    requirement:
      "Every architecture lock RL-LOCK-001..RL-LOCK-020 is covered by conformance suites: the mapped suite files exist, reference the lock id, and their owning package ran green.",
    evaluate: () => evaluateLockCoverage(repoRoot, suiteResults()),
  },
  {
    id: "MVP-3",
    requirement:
      "Every SLO in spec/architecture.md §11 instrumented by observability primitives with at least one dogfood/load assertion referencing it.",
    evaluate: () => evaluateSloInstrumentation(repoRoot),
  },
  {
    id: "MVP-4",
    requirement:
      "Every public API surface documented in spec/api.md is consistent with the actual exported contracts (resources, command semantics, envelope, webhooks).",
    evaluate: () => evaluateApiConsistency(repoRoot),
  },
];

// A clean env for the stack: the conformance violation toggle must never be
// inherited (the gate runs the DEFAULT green proofs).
const env = { ...process.env };
delete env.ROAMLINK_CONFORMANCE_VIOLATION;

const steps = gate.steps.map((step) => ({
  ...step,
  execute: (ctx) => {
    const result = step.execute(ctx);
    completedSteps.push(result);
    return result;
  },
}));

const report = runGate({
  gateId: gate.gateId,
  title: gate.title,
  steps,
  criteria,
  artifactPath: ARTIFACT_PATH,
  repoRoot,
  env,
  meta: {
    stack: ["install --frozen-lockfile", "lint", "typecheck", "test (all suites)", "architecture:check"],
    git: gitMeta(),
  },
  logger: jsonOnly ? () => {} : undefined,
});

process.stdout.write(stdoutSummary(report) + "\n");
if (!jsonOnly) {
  console.error(`\nMVP release gate verdict: ${report.verdict.status.toUpperCase()} (exit ${report.verdict.exitCode})`);
  console.error(`artifact: docs/reports/mvp-gate.json`);
  for (const failure of report.verdict.failedCriterionRows) {
    console.error(`  ✗ ${failure}`);
  }
}
process.exit(report.verdict.exitCode);
