/**
 * The standalone production ADCOS compatibility probe (RL-108).
 *
 * Runs the full §9 compatibility suite against the env-configured ADCOS
 * endpoint and exits with a DISTINCT code:
 *
 *   0  compatible      - the endpoint speaks the pinned contract; mutations
 *                        may flow;
 *   1  incompatible    - fail closed: mutations are gated (diagnosable,
 *                        value-free failed-check report on stdout);
 *   2  not-configured  - the ADCOS env is absent (honest; NEVER blocks
 *                        local/CI runs).
 *
 * Run: `pnpm --filter @roamlink/workers adcos:probe`
 */
import { runAdcosProductionProbe, ADCOS_PROBE_EXIT_CODES } from "@roamlink/compat";
import type { AdcosCompatibilityCheckResult } from "@roamlink/integration";

const result = await runAdcosProductionProbe({ env: process.env });

if (result.status === "not-configured") {
  console.log(
    JSON.stringify({ status: "not-configured", note: "ADCOS env is absent; the probe never blocks local/CI runs" }, null, 2),
  );
  process.exit(ADCOS_PROBE_EXIT_CODES["not-configured"]);
}

console.log(
  JSON.stringify(
    {
      status: result.status,
      suiteVersion: result.report.suiteVersion,
      at: result.report.at,
      checks: (result.report.checks as readonly AdcosCompatibilityCheckResult[]).map((check) => ({
        name: check.name,
        passed: check.passed,
        ...(check.code !== undefined ? { code: check.code } : {}),
        detail: check.detail,
      })),
      mutationsAllowed: result.status === "compatible",
    },
    null,
    2,
  ),
);
process.exit(ADCOS_PROBE_EXIT_CODES[result.status]);
