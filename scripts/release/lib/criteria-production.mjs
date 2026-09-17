/**
 * Production readiness gate criteria evaluators (RL-081) + the accepted-risk
 * registry validation.
 *
 * Beyond the MVP gate, the production gate evaluates: security/threat
 * verification with findings disposition, the deployment/recovery runbook,
 * operational observability (structured logging with correlation IDs,
 * honest health/readiness, wired §11 SLO instrumentation), docs completeness
 * (README quickstart, spec current-state consistency, CHANGELOG) and the
 * accepted-risk registry itself.
 *
 * HONESTY MODEL — how open gaps are handled without weakening a criterion:
 *  - every evaluator reports the LITERAL row status first (pass/fail);
 *  - a row that is unmet BUT covered by a validated accepted-risk record is
 *    re-marked `gap` with the covering risk ids attached — visible in the
 *    artifact, never silently converted to a pass;
 *  - a criterion passes only when it has NO unmet rows that lack coverage
 *    (uncovered failures keep status `fail` and fail the gate);
 *  - the registry itself (PRD-5) can never be covered by its own entries
 *    (circularity guard).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  extractBashBlocks,
  extractFindingIds,
  readText,
  stripComments,
  walkFiles,
} from "./gate-util.mjs";

/**
 * @typedef {{ id: string, title: string, criterion: string, rowId: string, severity: string, justification: string, remediation: string, owner: string, reviewBy: string, exposure?: string, references?: string[] }} AcceptedRiskRecord
 * @typedef {{ schema: string, risks: AcceptedRiskRecord[] }} AcceptedRiskRegistry
 */

/** The accepted-risk registry location (committed, reviewed data). */
export const ACCEPTED_RISKS_PATH = join("docs", "reports", "accepted-risks.json");

/** Closed severity vocabulary for accepted risks. */
export const RISK_SEVERITIES = ["low", "medium", "high", "critical"];

/** Production criterion ids (used by the registry for coverage mapping). */
export const PRODUCTION_CRITERION_IDS = ["PRD-1", "PRD-2", "PRD-3", "PRD-4", "PRD-5"];

/**
 * Loads and validates the accepted-risk registry.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, registry: AcceptedRiskRegistry | null, errors: string[] }}
 */
export function loadAcceptedRiskRegistry(repoRoot) {
  const path = join(repoRoot, ACCEPTED_RISKS_PATH);
  const text = readText(path);
  if (text === null) {
    return { ok: false, registry: null, errors: [`${ACCEPTED_RISKS_PATH} not found`] };
  }
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (error) {
    return { ok: false, registry: null, errors: [`${ACCEPTED_RISKS_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const errors = [];
  if (registry.schema !== "roamlink/accepted-risks@1") {
    errors.push(`schema must be "roamlink/accepted-risks@1" (found ${JSON.stringify(registry.schema)})`);
  }
  if (!Array.isArray(registry.risks)) {
    errors.push("risks must be an array");
    return { ok: false, registry, errors };
  }
  const seenIds = new Set();
  for (const risk of registry.risks) {
    for (const field of ["id", "title", "criterion", "rowId", "severity", "justification", "remediation", "owner", "reviewBy"]) {
      if (typeof risk[field] !== "string" || risk[field].length === 0) {
        errors.push(`${risk.id ?? "(unnamed risk)"}: field "${field}" must be a non-empty string`);
      }
    }
    if (typeof risk.id === "string") {
      if (seenIds.has(risk.id)) errors.push(`duplicate risk id ${risk.id}`);
      seenIds.add(risk.id);
    }
    if (typeof risk.severity === "string" && !RISK_SEVERITIES.includes(risk.severity)) {
      errors.push(`${risk.id}: severity "${risk.severity}" outside ${RISK_SEVERITIES.join("|")}`);
    }
    if ((risk.severity === "high" || risk.severity === "critical") && (typeof risk.exposure !== "string" || risk.exposure.length === 0)) {
      errors.push(`${risk.id}: high/critical risks must state an exposure bound`);
    }
    if (risk.criterion === "PRD-5") {
      errors.push(`${risk.id}: the registry cannot cover its own criterion (PRD-5)`);
    } else if (typeof risk.criterion === "string" && !PRODUCTION_CRITERION_IDS.includes(risk.criterion)) {
      errors.push(`${risk.id}: criterion "${risk.criterion}" is not a production criterion`);
    }
    if (risk.references !== undefined && !Array.isArray(risk.references)) {
      errors.push(`${risk.id}: references must be an array when present`);
    }
  }
  return { ok: errors.length === 0, registry, errors };
}

/**
 * Collects every finding ID recorded across the verification docs (threat
 * model, deployment/recovery, load-suite DEFECT records) — deduped, sorted.
 * PRD-5 requires every one of them to be referenced by an accepted-risk
 * record.
 */
export function extractRegistryFindings(repoRoot) {
  const sources = [
    join(repoRoot, "docs", "threat-model-verification.md"),
    join(repoRoot, "docs", "deployment-recovery.md"),
    join(repoRoot, "tests", "load", "README.md"),
  ];
  const ids = new Set();
  for (const source of sources) {
    const text = readText(source);
    if (text === null) continue;
    for (const finding of extractFindingIds(text)) ids.add(finding);
  }
  return [...ids].sort();
}

/**
 * Applies accepted-risk coverage to a criterion result: unmet rows covered by
 * the registry become `gap` rows carrying their risk ids; uncovered rows stay
 * `fail`. Recomputes the criterion status (pass only with zero uncovered
 * rows) and returns the result plus the list of uncovered rows.
 *
 * @param {import("./gate-engine.mjs").CriterionResult} criterionResult
 * @param {AcceptedRiskRegistry} registry
 * @returns {{ result: import("./gate-engine.mjs").CriterionResult, uncovered: string[] }}
 */
export function applyAcceptedRiskCoverage(criterionResult, registry) {
  const risks = Array.isArray(registry?.risks) ? registry.risks : [];
  const uncovered = [];
  const rows = criterionResult.rows.map((row) => {
    if (row.status === "pass") return row;
    const covering = risks.filter(
      (risk) => risk.criterion === criterionResult.id && risk.rowId === row.id,
    );
    if (covering.length === 0) {
      uncovered.push(row.id);
      return row;
    }
    return {
      ...row,
      status: "gap",
      acceptedRiskIds: covering.map((risk) => risk.id),
      summary: `${row.summary} [UNMET — covered by accepted risk${covering.length > 1 ? "s" : ""} ${covering.map((risk) => risk.id).join(", ")}]`,
    };
  });
  const gapRows = rows.filter((row) => row.status === "gap");
  return {
    result: {
      ...criterionResult,
      rows,
      status: uncovered.length === 0 ? "pass" : "fail",
      summary:
        uncovered.length === 0
          ? gapRows.length > 0
            ? `${criterionResult.summary}; ${gapRows.length} unmet row(s) explicitly covered by accepted-risk records: ${gapRows.map((row) => `${row.id}←${(row.acceptedRiskIds ?? []).join("+")}`).join(", ")}`
            : criterionResult.summary
          : `${criterionResult.summary}; UNCOVERED failing rows (no accepted-risk record): ${uncovered.join(", ")}`,
    },
    uncovered,
  };
}

/**
 * Evaluates PRD-1: security/threat verification complete with all negative
 * proofs green; every recorded finding dispositioned (no open HIGH findings
 * without an accepted-risk note — implemented strictly: EVERY finding must be
 * covered by the registry, whatever its severity).
 */
export function evaluateSecurityVerification(repoRoot, suiteResults) {
  const threatDocPath = join("docs", "threat-model-verification.md");
  const threatDoc = readText(join(repoRoot, threatDocPath)) ?? "";
  const deploymentDoc = readText(join(repoRoot, "docs", "deployment-recovery.md")) ?? "";
  const loadReadme = readText(join(repoRoot, "tests", "load", "README.md")) ?? "";
  const securitySuite = suiteResults["@roamlink/tests-security"];

  /** @type {import("./gate-engine.mjs").CriterionRow[]} */
  const rows = [];
  rows.push({
    id: "SEC:suite",
    status: securitySuite !== undefined && securitySuite.status === "pass" ? "pass" : "fail",
    summary:
      securitySuite === undefined
        ? "@roamlink/tests-security not present in the gate test step"
        : securitySuite.status === "pass"
          ? `@roamlink/tests-security green (${securitySuite.tests ? `${securitySuite.tests.passed}/${securitySuite.tests.total} tests` : "exit 0"})`
          : `@roamlink/tests-security NOT green (status ${securitySuite.status})`,
    evidence: ["tests/security/test/*.test.ts", "docs/threat-model-verification.md"],
  });

  const verifiedCount = (threatDoc.match(/\*\*VERIFIED\b/g) ?? []).length;
  const threatRows = (threatDoc.match(/^\| \d+ \|/gm) ?? []).length;
  rows.push({
    id: "SEC:negative-proofs",
    status: threatDoc.length > 0 && threatRows >= 10 && verifiedCount >= 10 ? "pass" : "fail",
    summary:
      threatDoc.length === 0
        ? "docs/threat-model-verification.md missing"
        : `threat-priority matrix: ${threatRows} threat rows, ${verifiedCount} VERIFIED verdict tokens${threatRows >= 10 && verifiedCount >= 10 ? "" : " (incomplete matrix)"}`,
    evidence: [threatDocPath],
  });

  const findings = [
    ...extractFindingIds(threatDoc),
    ...extractFindingIds(deploymentDoc),
    ...extractFindingIds(loadReadme),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const findingEvidence = findings.length > 0 ? findings.join(", ") : "none recorded";
  rows.push({
    id: "SEC:findings-recorded",
    status: findings.length > 0 ? "pass" : "fail",
    summary:
      findings.length > 0
        ? `${findings.length} recorded finding(s) across the verification docs (each must be dispositioned by the accepted-risk registry — see PRD-5)`
        : "no findings recorded in the verification docs (a verification wave with zero negative findings is suspicious — re-check)",
    evidence: [threatDocPath, "docs/deployment-recovery.md", "tests/load/README.md (DEFECT-1)", `findings: ${findingEvidence}`],
  });

  const threatGaps = countListItemsAfterHeading(threatDoc, /## .*honest gaps/i);
  const deploymentGaps = countListItemsAfterHeading(deploymentDoc, /## .*honest gaps/i);
  rows.push({
    id: "SEC:honest-gaps",
    status: threatGaps + deploymentGaps >= 5 ? "gap" : "fail",
    summary: `${threatGaps + deploymentGaps} documented inherent-infrastructure limit(s) (${threatGaps} threat-model, ${deploymentGaps} deployment) — these cannot be closed on this tree; they are explicit accepted risks, with the strongest deterministic proxies verified`,
    evidence: [
      `${threatDocPath} §Honest gaps (${threatGaps} items)`,
      `docs/deployment-recovery.md §Honest gaps (${deploymentGaps} items)`,
    ],
  });

  const failed = rows.filter((row) => row.status === "fail");
  return {
    id: "PRD-1",
    requirement:
      "Security/threat verification complete with all negative proofs green (RL-074 matrix); every recorded finding dispositioned via the accepted-risk registry — no open HIGH findings without an accepted-risk note (enforced for ALL severities).",
    status: failed.length === 0 ? "pass" : "fail",
    rows,
    summary:
      failed.length === 0
        ? "security verification green; findings + inherent limits explicitly dispositioned"
        : `${failed.length}/${rows.length} security rows failed: ${failed.map((row) => row.id).join(", ")}`,
  };
}

/**
 * Counts list items directly following a heading matching `pattern` —
 * both `- ` bullets and `1. ` numbered items (the real RL-074/RL-075 docs
 * number their honest-gap entries; the mini-repo fixtures use bullets).
 */
function countListItemsAfterHeading(markdown, pattern) {
  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length) {
    if (pattern.test(lines[index])) {
      let count = 0;
      let cursor = index + 1;
      while (cursor < lines.length && !/^##\s/.test(lines[cursor])) {
        if (/^\s*(?:-\s|\d+\.\s)/.test(lines[cursor])) count += 1;
        cursor += 1;
      }
      return count;
    }
    index += 1;
  }
  return 0;
}

/**
 * Evaluates PRD-2: the deployment/recovery runbook is verified — cold start,
 * crash recovery, backup/restore and dependency-failure modes all proven by
 * the RL-075 suites and documented in the runbook.
 */
export function evaluateDeploymentRunbook(repoRoot, suiteResults) {
  const doc = readText(join(repoRoot, "docs", "deployment-recovery.md")) ?? "";
  const suite = suiteResults["@roamlink/tests-deployment"];
  const legChecks = [
    { id: "DEPLOY:cold-start", keywords: ["cold start", "CS-"], file: "tests/deployment/test/cold-start-shutdown.test.ts" },
    { id: "DEPLOY:crash-recovery", keywords: ["crash", "M-5"], file: "tests/deployment/test/migration-recovery.test.ts" },
    { id: "DEPLOY:backup-restore", keywords: ["Backup", "Restore", "B-1"], file: "tests/deployment/test/backup-restore.test.ts" },
    { id: "DEPLOY:dependency-failure", keywords: ["ADCOS unreachable", "D-1"], file: "tests/deployment/test/dependency-failure.test.ts" },
  ];
  const rows = legChecks.map((leg) => {
    const fileExists = existsSync(join(repoRoot, leg.file));
    const docCovers = leg.keywords.every((keyword) => doc.toLowerCase().includes(keyword.toLowerCase()));
    const ok = fileExists && docCovers;
    return {
      id: leg.id,
      status: ok ? "pass" : "fail",
      summary: ok
        ? `verified: suite file present and the runbook documents the mode (${leg.keywords.join(", ")})`
        : `missing ${!fileExists ? `suite file ${leg.file}` : ""}${!fileExists && !docCovers ? " and " : ""}${!docCovers ? `runbook coverage of ${leg.keywords.join(", ")}` : ""}`,
      evidence: [leg.file, "docs/deployment-recovery.md"],
    };
  });
  rows.push({
    id: "DEPLOY:suite",
    status: suite !== undefined && suite.status === "pass" ? "pass" : "fail",
    summary:
      suite === undefined
        ? "@roamlink/tests-deployment not present in the gate test step"
        : suite.status === "pass"
          ? `@roamlink/tests-deployment green (${suite.tests ? `${suite.tests.passed}/${suite.tests.total} tests` : "exit 0"})`
          : `@roamlink/tests-deployment NOT green (status ${suite.status})`,
    evidence: ["tests/deployment/test/*.test.ts", "docs/deployment-recovery.md"],
  });
  const failed = rows.filter((row) => row.status !== "pass");
  return {
    id: "PRD-2",
    requirement:
      "Deployment/recovery runbook verified (RL-075): cold start, crash recovery, backup/restore and dependency-failure modes all proven by green suites and documented.",
    status: failed.length === 0 ? "pass" : "fail",
    rows,
    summary:
      failed.length === 0
        ? "all deployment/recovery legs verified and documented"
        : `${failed.length}/${rows.length} deployment rows failed: ${failed.map((row) => row.id).join(", ")}`,
  };
}

/**
 * Evaluates PRD-3: operational observability — structured logs with
 * correlation IDs verified end-to-end in dogfood scenarios; honest
 * health/readiness composition; §11 SLO instrumentation wired.
 */
export function evaluateObservability(repoRoot, suiteResults, sloRows) {
  /** @type {import("./gate-engine.mjs").CriterionRow[]} */
  const rows = [];
  const dogfoodFiles = walkFiles(repoRoot, "tests/dogfood", (path) => /\.(ts|tsx|mts|cts)$/.test(path));
  const dogfoodCode = dogfoodFiles
    .map((path) => ({ path, code: stripComments(readText(join(repoRoot, path)) ?? "") }))
    .filter((entry) => entry.code.length > 0);
  const wiringHits = dogfoodCode.filter(
    (entry) => entry.code.includes("@roamlink/observability") && /(makeLogger|createInMemoryLogSink|StructuredLogRecord|correlation)/.test(entry.code),
  );
  rows.push({
    id: "OBS:logs-correlation",
    status: wiringHits.length > 0 ? "pass" : "fail",
    summary:
      wiringHits.length > 0
        ? `structured logging with correlation IDs wired in dogfood scenarios (${wiringHits.map((entry) => entry.path).join(", ")})`
        : "the dogfood scenarios do NOT wire the observability structured logger (no @roamlink/observability import in tests/dogfood executable text) — correlation IDs are proven end-to-end through audit events, but structured-log records are not part of the dogfood evidence",
    evidence:
      wiringHits.length > 0
        ? wiringHits.map((entry) => entry.path)
        : ["tests/dogfood/src/world.ts (no observability import)", "packages/observability/src/logging/* (the verified logging contract)"],
  });

  const healthSuite = suiteResults["@roamlink/tests-deployment"];
  const healthFile = existsSync(join(repoRoot, "tests", "deployment", "test", "health-readiness.test.ts"));
  const deploymentDoc = readText(join(repoRoot, "docs", "deployment-recovery.md")) ?? "";
  const healthOk =
    healthFile &&
    healthSuite !== undefined &&
    healthSuite.status === "pass" &&
    /health\/readiness/i.test(deploymentDoc) &&
    /degraded/i.test(deploymentDoc);
  rows.push({
    id: "OBS:health-readiness",
    status: healthOk ? "pass" : "fail",
    summary: healthOk
      ? "health/readiness composition verified honest (degraded ≠ ready, unknown ≠ healthy, no-data SLOs never healthy; H-1..H-4)"
      : "health/readiness composition evidence incomplete",
    evidence: ["tests/deployment/test/health-readiness.test.ts", "docs/deployment-recovery.md"],
  });

  const unmetSlos = (sloRows ?? []).filter((row) => row.status !== "pass");
  rows.push({
    id: "OBS:slo-wiring",
    status: unmetSlos.length === 0 ? "pass" : "fail",
    summary:
      unmetSlos.length === 0
        ? "every §11 SLO is instrumented through the observability primitives and referenced by dogfood/load assertions"
        : `${unmetSlos.length} §11 SLO(s) lack operational wiring: ${unmetSlos.map((row) => row.id).join(", ")}`,
    evidence:
      unmetSlos.length === 0
        ? ["spec/architecture.md §11", "tests/dogfood/** + tests/load/** (references)", "packages/observability/src/slo/*"]
        : [
            "spec/architecture.md §11 (the SLO list)",
            ...unmetSlos.slice(0, 5).map((row) => `${row.id}: ${row.summary}`),
          ],
  });

  const failed = rows.filter((row) => row.status === "fail");
  return {
    id: "PRD-3",
    requirement:
      "Observability: structured logs with correlation IDs verified end-to-end in dogfood scenarios; health/readiness composition honest; operational §11 SLO instrumentation wired.",
    status: failed.length === 0 ? "pass" : "fail",
    rows,
    summary:
      failed.length === 0
        ? "observability criteria green"
        : `${failed.length}/${rows.length} observability rows failed: ${failed.map((row) => row.id).join(", ")}`,
  };
}

/**
 * Evaluates PRD-4: docs complete — README quickstart reproduces a local
 * dogfood run from a clean clone with copy-paste commands; every spec
 * document's current-state claims consistent with reality; CHANGELOG/release
 * notes drafted for an MVP release.
 */
export function evaluateDocsCompleteness(repoRoot) {
  /** @type {import("./gate-engine.mjs").CriterionRow[]} */
  const rows = [];
  const readme = readText(join(repoRoot, "README.md")) ?? "";
  const blocks = extractBashBlocks(readme);
  const quickstartHeading = /^##\s.*quickstart/im.test(readme);
  const dogfoodBlock = blocks.find(
    (block) => block.some((line) => /^pnpm\s+install/.test(line)) && block.some((line) => /tests\/dogfood/.test(line)),
  );
  let quickstartOk = quickstartHeading && dogfoodBlock !== undefined;
  const badCommands = [];
  if (dogfoodBlock !== undefined) {
    for (const line of dogfoodBlock) {
      const scoped = line.match(/^pnpm\s+-C\s+(\S+)\s+(\S+)/);
      if (scoped) {
        const manifest = readText(join(repoRoot, scoped[1], "package.json"));
        if (manifest === null) {
          badCommands.push(`${line} (no package.json at ${scoped[1]})`);
        } else {
          try {
            const scripts = JSON.parse(manifest).scripts ?? {};
            if (!scripts[scoped[2]]) badCommands.push(`${line} (script "${scoped[2]}" not declared)`);
          } catch {
            badCommands.push(`${line} (unparseable manifest at ${scoped[1]})`);
          }
        }
      }
    }
    if (badCommands.length > 0) quickstartOk = false;
  }
  rows.push({
    id: "DOCS:quickstart",
    status: quickstartOk ? "pass" : "fail",
    summary: quickstartOk
      ? "README quickstart reproduces a local dogfood run from a clean clone with copy-paste commands (every referenced pnpm script exists)"
      : `README quickstart incomplete: ${quickstartHeading ? "" : "no Quickstart heading; "}${dogfoodBlock === undefined ? "no bash block combining install + the dogfood run; " : ""}${badCommands.length > 0 ? `invalid commands: ${badCommands.join("; ")}` : ""}`.trim(),
    evidence: ["README.md §Quickstart", ...(dogfoodBlock ? [dogfoodBlock.join(" && ")] : [])],
  });

  const currentState = readText(join(repoRoot, "spec", "current-state.md")) ?? "";
  const implementedPackages = walkFiles(repoRoot, "packages", (path) => path.endsWith("src/index.ts"));
  const staleClaims = [];
  if (/no production feature implementation started/i.test(currentState) && implementedPackages.length > 0) {
    staleClaims.push(`"no production feature implementation started" contradicts ${implementedPackages.length} implemented packages (each with src/index.ts)`);
  }
  if (/greenfield/i.test(currentState) && implementedPackages.length > 0) {
    staleClaims.push(`"Repository state: greenfield" contradicts the implemented tree`);
  }
  rows.push({
    id: "DOCS:current-state",
    status: staleClaims.length === 0 ? "pass" : "fail",
    summary:
      staleClaims.length === 0
        ? "spec current-state claims are consistent with the implemented tree"
        : `stale current-state claims: ${staleClaims.join("; ")} — spec/* is outside the release-gate worker's editable scope by dispatch, so this is recorded as an explicit gap for the Tech Lead`,
    evidence: ["spec/current-state.md", `implemented packages: ${implementedPackages.length}`],
  });

  const changelog = readText(join(repoRoot, "CHANGELOG.md")) ?? "";
  const changelogOk = changelog.length > 0 && /MVP/i.test(changelog) && /^##\s/m.test(changelog);
  rows.push({
    id: "DOCS:changelog",
    status: changelogOk ? "pass" : "fail",
    summary: changelogOk
      ? "CHANGELOG drafted for the MVP release (scope, surfaces, verification stack, known gaps)"
      : "CHANGELOG.md missing or lacks an MVP release section",
    evidence: ["CHANGELOG.md"],
  });

  const failed = rows.filter((row) => row.status === "fail");
  return {
    id: "PRD-4",
    requirement:
      "Docs complete: README quickstart reproduces a local dogfood run from a clean clone with copy-paste commands; every spec document's current-state claims consistent with reality; CHANGELOG/release notes drafted for an MVP release.",
    status: failed.length === 0 ? "pass" : "fail",
    rows,
    summary:
      failed.length === 0
        ? "docs criteria green"
        : `${failed.length}/${rows.length} docs rows failed: ${failed.map((row) => row.id).join(", ")}`,
  };
}

/**
 * Evaluates PRD-5: the accepted-risk registry is valid and its coverage is
 * complete — every recorded finding appears in the registry, every registry
 * entry maps to a real evaluated row, and no production criterion row that
 * FAILED escaped coverage. This criterion cannot be covered by registry
 * entries itself (circularity guard in the loader).
 */
export function evaluateAcceptedRisks(repoRoot, evaluatedCriteria, findingsFromDocs) {
  /** @type {import("./gate-engine.mjs").CriterionRow[]} */
  const rows = [];
  const { ok, registry, errors } = loadAcceptedRiskRegistry(repoRoot);
  rows.push({
    id: "RISK:registry",
    status: ok ? "pass" : "fail",
    summary: ok
      ? `registry valid: ${registry.risks.length} accepted-risk record(s), schema + required fields + severity vocabulary checked`
      : `registry INVALID: ${errors.join("; ")}`,
    evidence: [ACCEPTED_RISKS_PATH],
  });

  if (!ok) {
    return {
      id: "PRD-5",
      requirement:
        "The accepted-risk registry is valid (schema, fields, severities, no self-coverage) and its coverage is complete (every finding and every unmet criterion row is explicitly dispositioned).",
      status: "fail",
      rows,
      summary: "accepted-risk registry invalid — production gate cannot pass",
    };
  }

  const knownRows = new Set(
    evaluatedCriteria.flatMap((criterion) => criterion.rows.map((row) => `${criterion.id}/${row.id}`)),
  );
  const orphanEntries = registry.risks.filter((risk) => !knownRows.has(`${risk.criterion}/${risk.rowId}`));
  rows.push({
    id: "RISK:no-orphans",
    status: orphanEntries.length === 0 ? "pass" : "fail",
    summary:
      orphanEntries.length === 0
        ? "every registry entry maps to an evaluated criterion row (no orphan bookkeeping)"
        : `orphan registry entries (criterion/row not evaluated by this gate): ${orphanEntries.map((risk) => `${risk.id}→${risk.criterion}/${risk.rowId}`).join(", ")}`,
    evidence: [ACCEPTED_RISKS_PATH],
  });

  const referencedFindings = new Set(registry.risks.flatMap((risk) => risk.references ?? []));
  const uncoveredFindings = findingsFromDocs.filter((finding) => !referencedFindings.has(finding));
  rows.push({
    id: "RISK:findings-coverage",
    status: uncoveredFindings.length === 0 ? "pass" : "fail",
    summary:
      uncoveredFindings.length === 0
        ? `every recorded finding (${findingsFromDocs.join(", ")}) is referenced by an accepted-risk record`
        : `findings WITHOUT accepted-risk coverage: ${uncoveredFindings.join(", ")}`,
    evidence: [ACCEPTED_RISKS_PATH, ...findingsFromDocs],
  });

  const highRisks = registry.risks.filter((risk) => risk.severity === "high" || risk.severity === "critical");
  const missingDisposition = highRisks.filter(
    (risk) => !risk.exposure || !risk.owner || !risk.reviewBy || !risk.remediation,
  );
  rows.push({
    id: "RISK:high-disposition",
    status: missingDisposition.length === 0 ? "pass" : "fail",
    summary:
      missingDisposition.length === 0
        ? highRisks.length === 0
          ? "no high/critical accepted risks recorded"
          : `all ${highRisks.length} high/critical accepted risk(s) carry exposure bounds, owners, review milestones and remediation paths`
        : `high/critical risks missing disposition fields: ${missingDisposition.map((risk) => risk.id).join(", ")}`,
    evidence: [ACCEPTED_RISKS_PATH],
  });

  const failed = rows.filter((row) => row.status === "fail");
  return {
    id: "PRD-5",
    requirement:
      "The accepted-risk registry is valid (schema, fields, severities, no self-coverage) and its coverage is complete (every finding and every unmet criterion row is explicitly dispositioned).",
    status: failed.length === 0 ? "pass" : "fail",
    rows,
    summary:
      failed.length === 0
        ? "accepted-risk discipline holds"
        : `${failed.length}/${rows.length} registry rows failed: ${failed.map((row) => row.id).join(", ")}`,
  };
}
