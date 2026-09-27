/**
 * The offline selftest (PA-021 §3.6): proves the RUNNER MACHINERY, not a
 * deployment. Deterministic and loopback-only — no deployed URL is ever
 * contacted.
 *
 *  1. no env → the named skip (the config law + the CLI subprocess law);
 *  2. the dummy local fixture + the offline fake driver → the full journey
 *     matrix exercises end to end: level recording, the honest-stop
 *     taxonomy, mutation submissions through the real flow plane (with the
 *     same-origin Origin header), the typed-panel assertions, the a11y
 *     battery's structural checks + its named skips, and the report shape;
 *  3. the same fixture + the REAL headless browser (browser-gated: when
 *     chromium cannot launch on this box the leg records the NAMED skip
 *     and still passes — never a fake pass, never a hard fail);
 *  4. a lying terrain (a bare stub with no portal markers) → the run FAILS
 *     (the no-lie law's teeth: legs that cannot evidence their floor fail
 *     the exit contract).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_PERSONA, DEFAULT_CUSTOMER, SKIP_REASON_ENV_NOT_CONFIGURED, configFromEnv } from "../src/config.js";
import { createFakeDriver, probeBrowserAvailability } from "../src/driver.js";
import { startFixtureSite } from "../src/fixture/site.js";
import { runAcceptanceMatrix, type AcceptanceRunReport } from "../src/runner.js";
import { renderHumanSummary } from "../src/report.js";

let fixture: { origin: string; close: () => Promise<void> } | null = null;

beforeAll(async () => {
  fixture = await startFixtureSite();
});

afterAll(async () => {
  await fixture?.close();
});

function fixtureConfig(): Parameters<typeof runAcceptanceMatrix>[0]["config"] {
  return {
    status: "configured",
    baseUrl: fixture?.origin ?? "http://127.0.0.1:1",
    customer: DEFAULT_CUSTOMER,
    adminPersona: DEFAULT_ADMIN_PERSONA,
    timeoutMs: 8_000,
    reportDir: mkdtempSync(join(tmpdir(), "pa021-selftest-")),
  } satisfies NonNullable<Parameters<typeof runAcceptanceMatrix>[0]["config"]>;
}

function legOf(report: AcceptanceRunReport, journey: string, leg: string, viewport = "desktop"): undefined | (typeof report.legs)[number] {
  return report.legs.find(
    (candidate) => candidate.journey === journey && candidate.leg === leg && candidate.viewport === viewport,
  );
}

describe("1. no env → the named skip", () => {
  it("configFromEnv yields the named skip on an empty env surface", () => {
    const config = configFromEnv({});
    expect(config.status).toBe("skipped");
    if (config.status !== "skipped") throw new Error("unreachable");
    expect(config.skipReason).toBe(SKIP_REASON_ENV_NOT_CONFIGURED);
  });

  it("the CLI itself skips with the named reason and exits 0 on an unconfigured box", async () => {
    const packageRoot = join(import.meta.dirname, "..");
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("ACCEPTANCE_")) continue;
      if (value !== undefined) env[key] = value;
    }
    const exit = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(packageRoot, "src", "cli.ts")],
        { env, cwd: packageRoot },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(exit.code).toBe(0);
    expect(exit.stdout).toContain("SKIPPED");
    expect(exit.stdout).toContain("ACCEPTANCE_BASE_URL_NOT_CONFIGURED");
    expect(exit.stderr).toBe("");
  }, 60_000);
});

describe("2. the dummy local fixture + the offline fake driver (the runner machinery)", () => {
  let report: AcceptanceRunReport;

  beforeAll(async () => {
    report = await runAcceptanceMatrix({
      config: fixtureConfig(),
      driver: createFakeDriver(fixture?.origin ?? "http://127.0.0.1:1"),
      log: () => {},
    });
  }, 120_000);

  it("runs the full matrix at both viewport classes", () => {
    expect(report.viewports.map((viewport) => viewport.label)).toEqual(["desktop", "mobile"]);
    expect(report.legs.length).toBeGreaterThan(40);
    expect(report.legs.some((leg) => leg.viewport === "desktop")).toBe(true);
    expect(report.legs.some((leg) => leg.viewport === "mobile")).toBe(true);
  });

  it("records the honest level ladder: login reaches user-visible evidence", () => {
    const submit = legOf(report, "login", "submit");
    expect(submit?.reachedLevel).toBe("user-visible-evidence");
    expect(submit?.failure).toBeUndefined();
  });

  it("records the honest level ladder: the fixture's create-intent executes and becomes user-visible", () => {
    const create = legOf(report, "goals", "create");
    expect(create?.reachedLevel).toBe("mutation-executed");
    const visible = legOf(report, "goals", "visible");
    expect(visible?.reachedLevel).toBe("user-visible-evidence");
  });

  it("records the accepted-not-executed honest stop (the multi-tick truth)", () => {
    const enroll = legOf(report, "onboarding", "enroll-device");
    expect(enroll?.reachedLevel).toBe("mutation-accepted");
    expect(enroll?.stopReason).toContain("accepted but the executed stage is not reached");
    const deviceEnroll = legOf(report, "devices", "enroll");
    expect(deviceEnroll?.reachedLevel).toBe("mutation-accepted");
  });

  it("records the typed-refusal honest stop with the reason verbatim", () => {
    const install = legOf(report, "esim", "install");
    expect(install?.reachedLevel).toBe("surface-rendered");
    expect(install?.stopReason).toContain("ESIM_MUTATION_NOT_COMPOSED");
    expect(install?.failure).toBeUndefined();
    const activate = legOf(report, "goals", "activate");
    expect(activate?.stopReason).toContain("INTENT_NOT_EXECUTED");
  });

  it("records the page-level fail-closed read stop (commerce)", () => {
    const page = legOf(report, "plans-billing", "page");
    expect(page?.reachedLevel).toBe("surface-rendered");
    expect(page?.stopReason).toContain("READ_MODEL_NOT_COMPOSED");
    const order = legOf(report, "plans-billing", "order");
    expect(order?.stopReason).toContain("no commerce read composed");
  });

  it("records the admin gate's honest denial", () => {
    const console = legOf(report, "admin", "console");
    expect(console?.reachedLevel).toBe("surface-rendered");
    expect(console?.stopReason).toContain("org:read");
    expect(console?.failure).toBeUndefined();
    const slo = legOf(report, "admin", "slo");
    expect(slo?.stopReason).toContain("gate denies");
  });

  it("collects the PA-020 quiet panels it walked past", () => {
    const panels = report.legs.flatMap((leg) => leg.degradedPanels);
    expect(panels.some((panel) => panel.section === "connectivity-events")).toBe(true);
    expect(panels.some((panel) => panel.section === "workspace-read")).toBe(true);
    expect(panels.every((panel) => panel.reason.length > 0)).toBe(true);
  });

  it("the a11y battery's structural checks pass and its layout/keyboard checks are NAMED skips (no fake passes)", () => {
    expect(report.a11yCounts["one-h1"]?.pass ?? 0).toBeGreaterThan(0);
    expect(report.a11yCounts["one-h1"]?.fail ?? 1).toBe(0);
    expect(report.a11yCounts["heading-order"]?.fail ?? 1).toBe(0);
    expect(report.a11yCounts["skip-link"]?.pass ?? 0).toBeGreaterThan(0);
    expect((report.a11yCounts["touch-targets"]?.skip ?? 0)).toBeGreaterThan(0);
    expect((report.a11yCounts["tab-order-sample"]?.skip ?? 0)).toBeGreaterThan(0);
    expect((report.a11yCounts["focus-visibility"]?.skip ?? 0)).toBeGreaterThan(0);
    expect(report.a11yCounts["touch-targets"]?.pass ?? 0).toBe(0);
    expect(report.a11yCounts["tab-order-sample"]?.pass ?? 0).toBe(0);
  });

  it("emits the no-lies verdict with zero failures", () => {
    expect(report.legFailures).toEqual([]);
    expect(report.a11yFailures).toEqual([]);
    expect(report.verdict).toBe("no-lies");
    // The level counts are per-FURTHEST-level (a leg that evidenced both
    // route and surface counts once, at surface): the fixture terrain
    // spans every level of the ladder.
    expect(report.levelCounts["surface-rendered"]).toBeGreaterThan(0);
    expect(report.levelCounts["read-available"]).toBeGreaterThan(0);
    expect(report.levelCounts["mutation-accepted"]).toBeGreaterThan(0);
    expect(report.levelCounts["mutation-executed"]).toBeGreaterThan(0);
    expect(report.levelCounts["user-visible-evidence"]).toBeGreaterThan(0);
    const counted = Object.values(report.levelCounts).reduce((sum, count) => sum + count, 0);
    const evidenced = report.legs.filter((leg) => leg.reachedLevel !== null).length;
    expect(counted).toBe(evidenced);
  });

  it("renders a human summary that names the target, driver, terrain and verdict", () => {
    const summary = renderHumanSummary(report);
    expect(summary).toContain("RoamLink deployed-browser acceptance (PA-021)");
    expect(summary).toContain("journey terrain");
    expect(summary).toContain("level terrain");
    expect(summary).toContain("honest stops (named)");
    expect(summary).toContain("verdict: no lies");
  });
});

describe("3. the real-browser leg (browser-gated: a named skip when chromium is unavailable)", () => {
  it(
    "drives the same fixture with real headless Chromium — or records the named skip",
    async () => {
      const probe = await probeBrowserAvailability();
      if (!probe.ok) {
        // The honest capability skip: the machinery leg above already
        // proved the runner; this leg never fakes a pass.
        console.log(`[selftest] real-browser leg SKIPPED — ${probe.reason.slice(0, 200)}`);
        expect(probe.reason.length).toBeGreaterThan(0);
        return;
      }
      const { createPlaywrightDriver } = await import("../src/driver.js");
      const driver = await createPlaywrightDriver(fixture?.origin ?? "http://127.0.0.1:1");
      try {
        const report = await runAcceptanceMatrix({
          config: fixtureConfig(),
          driver,
          log: () => {},
        });
        // The real browser runs the FULL battery: layout + keyboard checks
        // are present (not skipped) and they pass against the fixture's
        // shell contract; the run still tells no lies.
        expect(report.verdict).toBe("no-lies");
        expect(report.legFailures).toEqual([]);
        expect(report.a11yFailures).toEqual([]);
        expect(report.a11yCounts["touch-targets"]?.pass ?? 0).toBeGreaterThan(0);
        expect(report.a11yCounts["touch-targets"]?.fail ?? 1).toBe(0);
        // (touch-targets keeps its NAMED skip on the ops-console pages —
        // RL-114 scoped the verified floor to the customer web-app styles —
        // so a non-zero skip count is the honest scoping note, not a gap.)
        expect(report.a11yCounts["tab-order-sample"]?.pass ?? 0).toBeGreaterThan(0);
        expect(report.a11yCounts["tab-order-sample"]?.skip ?? 1).toBe(0);
        expect(report.a11yCounts["focus-visibility"]?.pass ?? 0).toBeGreaterThan(0);
        expect(report.a11yCounts["focus-visibility"]?.skip ?? 1).toBe(0);
        expect(report.a11yCounts["bottom-nav-mobile"]?.pass ?? 0).toBeGreaterThan(0);
        expect(report.a11yCounts["sidebar-desktop"]?.pass ?? 0).toBeGreaterThan(0);
        // The keyboard-submit evidence: the desktop login goes through
        // Enter on the credential form.
        const submit = report.legs.find(
          (leg) => leg.journey === "login" && leg.leg === "submit" && leg.viewport === "desktop",
        );
        expect(submit?.evidence.join(" ")).toContain("keyboard Enter");
      } finally {
        await driver.close();
      }
    },
    240_000,
  );
});

describe("4. a lying terrain fails honestly (the no-lie law's teeth)", () => {
  it(
    "a bare stub with no portal markers produces leg failures and the lies-detected verdict",
    async () => {
      const { createServer } = await import("node:http");
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body><h1>OK</h1></body></html>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const origin =
        address !== null && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : "http://127.0.0.1:1";
      try {
        const report = await runAcceptanceMatrix({
          config: {
            status: "configured",
            baseUrl: origin,
            customer: DEFAULT_CUSTOMER,
            adminPersona: DEFAULT_ADMIN_PERSONA,
            timeoutMs: 5_000,
            reportDir: mkdtempSync(join(tmpdir(), "pa021-lying-")),
          },
          driver: createFakeDriver(origin),
          log: () => {},
        });
        expect(report.verdict).toBe("lies-detected");
        expect(report.legFailures.length).toBeGreaterThan(0);
        // And no leg ever recorded a level it did not evidence: the login
        // document leg fails on the h1-only shell? The stub renders one h1,
        // so the surface check passes — but the page-marker checks fail.
        const failures = report.legFailures.join("\n");
        expect(failures.length).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
    120_000,
  );
});
