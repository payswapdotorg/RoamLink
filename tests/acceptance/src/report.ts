/**
 * The level report (PA-021 §3.5): the machine-readable JSON + the human
 * summary. Per journey: the furthest level reached + the honest stop
 * reasons; per run: the level terrain counts, the a11y battery counts, the
 * named-skip/skip census, the retries, and the no-lies verdict.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LEVELS } from "./levels.js";
import type { AcceptanceRunReport } from "./runner.js";

/** Renders the human summary (stdout). */
export function renderHumanSummary(report: AcceptanceRunReport): string {
  const lines: string[] = [];
  lines.push("RoamLink deployed-browser acceptance (PA-021)");
  lines.push(`target:    ${report.baseUrl}`);
  lines.push(`driver:    ${report.driverLabel}`);
  lines.push(
    `viewports: ${report.viewports.map((viewport) => `${viewport.label} ${viewport.width}x${viewport.height}`).join(", ")}`,
  );
  lines.push(`personas:  ${report.personas.join(", ")}`);
  lines.push(`started:   ${report.startedAt}`);
  lines.push("");

  lines.push("journey terrain (per journey x persona x viewport: the furthest evidenced level)");
  for (const journey of report.journeys) {
    const level = journey.furthestLevel ?? "unreached";
    const stops = journey.honestStops.length;
    lines.push(
      `  ${journey.journey.padEnd(16)} [${journey.persona}/${journey.viewport}]  ${level.padEnd(22)} (${journey.legs.length} legs, ${stops} honest stop${stops === 1 ? "" : "s"})`,
    );
    for (const leg of journey.legs) {
      const marker =
        leg.failure !== undefined ? "FAIL" : leg.stopReason !== undefined ? "stop" : leg.reachedLevel === leg.targetLevel ? "full" : "part";
      const reached = leg.reachedLevel ?? "unreached";
      lines.push(`      ${marker.padEnd(4)} ${leg.leg.padEnd(18)} ${reached}`);
      if (leg.failure !== undefined) lines.push(`           failure: ${leg.failure}`);
      if (leg.stopReason !== undefined) lines.push(`           stop:    ${leg.stopReason}`);
    }
  }
  lines.push("");

  lines.push("level terrain:");
  for (const level of LEVELS) {
    lines.push(`  ${report.levelCounts[level] ?? 0} ${level}`);
  }
  lines.push("");

  if (report.honestStopCounts.length > 0) {
    lines.push("honest stops (named):");
    for (const stop of report.honestStopCounts) {
      lines.push(`  ${stop.count}x ${stop.reason}`);
    }
    lines.push("");
  }

  lines.push("a11y battery:");
  for (const [name, counts] of Object.entries(report.a11yCounts)) {
    lines.push(`  ${name.padEnd(20)} ${counts.pass} pass / ${counts.fail} fail / ${counts.skip} skip`);
  }
  lines.push("");

  lines.push(`retries: ${report.retries.navigationRetries} navigation, ${report.retries.relogins} relogin`);
  lines.push(`leg failures: ${report.legFailures.length}`);
  for (const failure of report.legFailures) lines.push(`  - ${failure}`);
  lines.push(`a11y failures: ${report.a11yFailures.length}`);
  for (const failure of report.a11yFailures) lines.push(`  - ${failure}`);
  lines.push("");
  lines.push(
    report.verdict === "no-lies"
      ? "verdict: no lies — every leg evidenced its recorded level; honest limitations are recorded as named stops"
      : "verdict: LIES DETECTED — one or more legs could not evidence their floor or the a11y contract broke; see the failures above",
  );
  return lines.join("\n");
}

/** Writes the machine-readable JSON report (default: the package's .tmp dir). */
export async function writeJsonReport(
  report: AcceptanceRunReport,
  reportDir: string,
): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `acceptance-report-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const latest = join(reportDir, "acceptance-report-latest.json");
  await writeFile(latest, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}
