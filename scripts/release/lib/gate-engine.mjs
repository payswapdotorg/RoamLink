/**
 * The reusable release-gate engine (RL-080/RL-081).
 *
 * Zero external dependencies: plain Node ESM, synchronous child-process
 * execution, injectable seams for deterministic machinery tests
 * (`tests/release-gates`):
 *
 *  - `runner`   — how a command is executed (default: spawnSync);
 *  - `now`      — the clock for `generatedAt`/durations bookkeeping;
 *  - `writer`   — artifact emission (default: fs.writeFileSync + mkdir);
 *  - `logger`   — human progress output (default: console.error, so the
 *                 machine-readable summary can own stdout).
 *
 * A gate is an ordered list of STEPS (the verification stack, dependency
 * order) followed by CRITERIA evaluation (the pass bar). The engine is
 * EXIT-FAITHFUL: the returned verdict maps 1:1 onto the process exit code —
 * zero only on full pass, non-zero on ANY failure. A `critical` step failure
 * short-circuits the remaining steps (hard prerequisites) but never turns a
 * failure into a pass.
 *
 * Row status vocabulary: `pass` (criterion row met), `fail` (unmet, counts
 * against the verdict), `gap` (unmet but explicitly covered by validated
 * accepted-risk records — recorded for honesty, never silently converted;
 * whether a `gap` row is tolerable is the CRITERION EVALUATOR's decision,
 * which the gate artifact always discloses).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default stdout/stderr capture limit for child processes. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The default command runner: spawnSync with piped output.
 * Returns a plain result object — no thrown errors, failures are data.
 *
 * @param {readonly string[]} command
 * @param {{ cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} options
 * @returns {{ command: string, exitCode: number, stdout: string, stderr: string, durationMs: number, timedOut: boolean }}
 */
export function defaultRunner(command, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: options.timeoutMs ?? 15 * 60 * 1000,
  });
  return {
    command: command.join(" "),
    exitCode: result.status ?? (result.error ? -1 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - startedAt,
    timedOut: result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT",
  };
}

/** Default artifact writer. */
export function defaultWriter(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/**
 * Runs one gate to completion and returns the full report. Never throws for
 * step/criterion failures — everything is captured in the report.
 *
 * @param {{
 *   gateId: string,
 *   title: string,
 *   steps: Array<{ id: string, label: string, critical?: boolean, execute: (ctx: GateContext) => StepResult }>,
 *   criteria?: Array<Criterion>,
 *   artifactPath: string,
 *   repoRoot: string,
 *   runner?: Runner,
 *   now?: () => string,
 *   writer?: (path: string, contents: string) => void,
 *   logger?: (line: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   meta?: Record<string, unknown>,
 *   evaluateCriteriaOnStepFailure?: boolean,
 *   finalizeReport?: (report: any) => void,
 * }} config
 *
 * @typedef {{ command: (command: readonly string[], options: { cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }) => RunnerResult, repoRoot: string, env: NodeJS.ProcessEnv, log: (line: string) => void }} GateContext
 * @typedef {{ command: string, exitCode: number, stdout: string, stderr: string, durationMs: number, timedOut: boolean }} RunnerResult
 * @typedef {{ id: string, label: string, status: "pass" | "fail" | "skipped", exitCode?: number, durationMs?: number, summary?: string, details?: Record<string, unknown>, outputTail?: string[] }} StepResult
 * @typedef {{ id: string, requirement: string, evaluate: () => CriterionResult }} Criterion
 * @typedef {{ id: string, requirement: string, status: string, rows: CriterionRow[], summary: string, acceptedRiskIds?: string[] }} CriterionResult
 * @typedef {{ id: string, status: string, summary: string, evidence: string[], acceptedRiskIds?: string[] }} CriterionRow
 */
export function runGate(config) {
  const runner = config.runner ?? defaultRunner;
  const now = config.now ?? (() => new Date().toISOString());
  const writer = config.writer ?? defaultWriter;
  const log = config.logger ?? ((line) => console.error(line));
  const generatedAt = now();

  /** @type {StepResult[]} */
  const steps = [];
  let shortCircuited = false;

  const ctx = {
    command: runner,
    repoRoot: config.repoRoot,
    env: config.env ?? process.env,
    log,
  };

  for (const step of config.steps) {
    if (shortCircuited) {
      steps.push({
        id: step.id,
        label: step.label,
        status: "skipped",
        summary: "skipped: an earlier critical step failed (hard prerequisite)",
      });
      continue;
    }
    log(`▶ step ${step.id}: ${step.label}`);
    let result;
    try {
      result = step.execute(ctx);
    } catch (error) {
      result = {
        id: step.id,
        label: step.label,
        status: "fail",
        summary: `step threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (result.status !== "pass" && step.critical) {
      shortCircuited = true;
    }
    steps.push(result);
    log(`  ${result.status === "pass" ? "✓" : "✗"} ${result.id} — ${result.summary ?? result.status}`);
  }

  const stepsAllPass = steps.every((step) => step.status === "pass");

  /**
   * `evaluateCriteriaOnStepFailure` lets a gate produce full criteria
   * evidence for its report even when a step failed (diagnostics mode). The
   * VERDICT is unaffected: a failed step fails the gate regardless.
   */
  const evaluateCriteria = Boolean(config.criteria?.length) && (stepsAllPass || config.evaluateCriteriaOnStepFailure === true);

  /** @type {CriterionResult[]} */
  const criteria = [];
  if (evaluateCriteria) {
    for (const criterion of config.criteria) {
      log(`▶ criterion ${criterion.id}`);
      let result;
      try {
        result = criterion.evaluate();
      } catch (error) {
        result = {
          id: criterion.id,
          requirement: criterion.requirement,
          status: "fail",
          rows: [],
          summary: `criterion evaluation threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      criteria.push(result);
      log(`  ${result.status === "pass" ? "✓" : "✗"} ${criterion.id} — ${result.summary}`);
    }
  } else if (config.criteria?.length) {
    for (const criterion of config.criteria) {
      criteria.push({
        id: criterion.id,
        requirement: criterion.requirement,
        status: "fail",
        rows: [],
        summary: stepsAllPass
          ? "criterion not evaluated"
          : "not evaluated: a gate step failed (criteria depend on a green stack; re-run with --full-report for evidence-only evaluation)",
      });
    }
  }

  const failedRows = criteria.flatMap((criterion) =>
    criterion.rows.filter((row) => row.status === "fail").map((row) => `${criterion.id}/${row.id}`),
  );
  const acceptedRisks = [
    ...new Set(
      criteria.flatMap((criterion) => [
        ...(criterion.acceptedRiskIds ?? []),
        ...criterion.rows.flatMap((row) => row.acceptedRiskIds ?? []),
      ]),
    ),
  ].sort();
  const verdict = {
    status: stepsAllPass && criteria.every((criterion) => criterion.status === "pass") ? "pass" : "fail",
    exitCode:
      stepsAllPass && criteria.every((criterion) => criterion.status === "pass") ? 0 : 1,
    failedSteps: steps.filter((step) => step.status === "fail").map((step) => step.id),
    skippedSteps: steps.filter((step) => step.status === "skipped").map((step) => step.id),
    failedCriteria: criteria.filter((criterion) => criterion.status !== "pass").map((criterion) => criterion.id),
    failedCriterionRows: failedRows,
    acceptedRisks,
  };

  /** @type {{ schema: string, gate: string, title: string, generatedAt: string, verdict: typeof verdict, steps: StepResult[], criteria: CriterionResult[], artifactError?: string } & Record<string, unknown> } */
  const report = {
    schema: "roamlink/release-gate@1",
    gate: config.gateId,
    title: config.title,
    generatedAt,
    verdict,
    steps,
    criteria,
    ...(config.meta ?? {}),
  };

  /**
   * `finalizeReport` lets the gate enrich the report AFTER criteria
   * evaluation but BEFORE artifact emission (e.g. embedding a prerequisite
   * gate's verdict read from its artifact). A throwing finalizer is logged
   * and never rescues the verdict.
   */
  if (typeof config.finalizeReport === "function") {
    try {
      config.finalizeReport(report);
    } catch (error) {
      log(`! finalizeReport failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const artifactContents = JSON.stringify(report, null, 2) + "\n";
  try {
    writer(config.artifactPath, artifactContents);
  } catch (error) {
    log(`! artifact emission failed: ${error instanceof Error ? error.message : String(error)}`);
    report.verdict.status = "fail";
    report.verdict.exitCode = 1;
    report.artifactError = error instanceof Error ? error.message : String(error);
  }

  return report;
}

/**
 * The machine-readable summary printed to stdout: a single JSON document.
 * Kept compact — the full detail lives in the artifact.
 */
export function stdoutSummary(report) {
  return JSON.stringify(
    {
      schema: "roamlink/release-gate-summary@1",
      gate: report.gate,
      generatedAt: report.generatedAt,
      verdict: report.verdict,
      steps: report.steps.map((step) => ({
        id: step.id,
        status: step.status,
        ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      })),
      criteria: report.criteria.map((criterion) => ({
        id: criterion.id,
        status: criterion.status,
        failedRows: criterion.rows
          .filter((row) => row.status !== "pass")
          .map((row) => ({ id: row.id, status: row.status, summary: row.summary, acceptedRiskIds: row.acceptedRiskIds ?? [] })),
      })),
      acceptedRisks: report.verdict.acceptedRisks ?? [],
    },
    null,
    2,
  );
}

/**
 * Builds a plain command step. The execute function runs `command` through
 * the context runner and derives pass/fail from the exit code.
 *
 * @param {{ id: string, label: string, command: readonly string[], cwd?: string, critical?: boolean, timeoutMs?: number, tailLines?: number }} spec
 */
export function commandStep(spec) {
  return {
    id: spec.id,
    label: spec.label,
    critical: spec.critical ?? false,
    execute: (ctx) => {
      const result = ctx.command(spec.command, {
        cwd: spec.cwd ?? ctx.repoRoot,
        timeoutMs: spec.timeoutMs,
        env: ctx.env,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const tail = output
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(-(spec.tailLines ?? 12));
      return {
        id: spec.id,
        label: spec.label,
        status: result.exitCode === 0 ? "pass" : "fail",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        summary:
          result.exitCode === 0
            ? `exit 0 (${result.durationMs}ms)`
            : result.timedOut
              ? `timed out after ${result.timeoutMs ?? "the step"}ms`
              : `exit ${result.exitCode}`,
        outputTail: tail,
      };
    },
  };
}
