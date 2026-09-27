/**
 * The deployed-run CLI (PA-021): `pnpm acceptance:deployed`.
 *
 * Env-gated, fail-closed to skip (the house honest-skip law):
 *  - ACCEPTANCE_BASE_URL unset → the named skip is printed and the process
 *    exits 0 (an unconfigured box never fails, never fake-passes);
 *  - ACCEPTANCE_BASE_URL malformed → exit 2 (a misconfigured invocation,
 *    the smoke runner's law);
 *  - configured but the browser cannot launch → exit 1 (the run was
 *    requested; an unavailable driver is an honest failure, not a skip);
 *  - configured + driven → the journey matrix runs, the level report is
 *    emitted (stdout + JSON artifact) and the process exits 0 ONLY under
 *    the no-lies contract.
 */
import { configFromEnv } from "./config.js";
import { createPlaywrightDriver, probeBrowserAvailability } from "./driver.js";
import { runAcceptanceMatrix } from "./runner.js";
import { renderHumanSummary, writeJsonReport } from "./report.js";

export async function cliMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config;
  try {
    config = configFromEnv(env);
  } catch (error) {
    console.error(`acceptance: ${error instanceof Error ? error.message : "the env surface is malformed"}`);
    return 2;
  }
  if (config.status === "skipped") {
    console.log(`acceptance: SKIPPED — ${config.skipReason ?? "not configured"}`);
    console.log("acceptance: the deployed-browser journey suite is env-gated; this is a named skip (exit 0).");
    return 0;
  }

  const probe = await probeBrowserAvailability();
  if (!probe.ok) {
    console.error(
      `acceptance: the real-browser driver is unavailable on this machine: ${probe.reason.slice(0, 400)}`,
    );
    console.error("acceptance: the run was requested (ACCEPTANCE_BASE_URL is set), so this is an honest failure — exit 1.");
    return 1;
  }
  console.log(`acceptance: driver ${probe.label}`);

  const driver = await createPlaywrightDriver(config.baseUrl);
  try {
    const report = await runAcceptanceMatrix({
      config,
      driver,
      log: (line) => console.log(line),
    });
    const summary = renderHumanSummary(report);
    const jsonPath = await writeJsonReport(report, config.reportDir);
    console.log("");
    console.log(summary);
    console.log("");
    console.log(`acceptance: machine-readable report written to ${jsonPath}`);
    return report.verdict === "no-lies" ? 0 : 1;
  } finally {
    await driver.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === new URL(`file://${process.argv[1]}`).href ||
    import.meta.url === `file://${process.argv[1]}`);

if (invokedDirectly) {
  cliMain()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(`acceptance: the run aborted: ${error instanceof Error ? error.message : "unknown failure"}`);
      process.exit(1);
    });
}
