/**
 * RL-109 — the host-side operator SLO dashboard: real recorder state, the
 * fail-closed session/permission gate, and the honest env parsing.
 *
 * Every rendered number in these tests flows from events recorded through
 * the PUBLIC product-SLO recorder — zero mocked evaluations.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";

import { handleOpsSloSurface } from "../src/handlers.js";
import {
  createHostSloBindings,
  parseSloObjectivesEnv,
  SLO_OBJECTIVES_ENV_KEY,
} from "../src/slo.js";

const T0 = "2026-11-01T12:00:00.000Z";
const OPERATOR_PERMISSION = "org:read";

const clock = new DeterministicClock(T0);

const bindings = createHostSloBindings({
  objectivesRaw:
    "intent-satisfaction-rate:0.99:86400000,provider-access-failover-success:0.9:86400000",
  now: () => clock.now(),
});

const request = (cookie?: string): Request =>
  new Request("https://host.example.test/ops/slo", {
    headers: cookie === undefined ? {} : { cookie },
  });

const runtime = {
  ok: true as const,
  composition: {
    api: {
      async handle(request: { path: string; headers: Record<string, string> }) {
        const authorization = request.headers["authorization"] ?? "";
        const token = authorization.replace(/^Bearer\s+/i, "");
        if (token !== "operator-session-token" && token !== "personal-session-token") {
          return { status: 401, body: undefined };
        }
        return {
          status: 200,
          body: JSON.stringify({
            actorId: "usr:00000000-0000-4000-8000-00000000000a",
            userId: "usr:00000000-0000-4000-8000-00000000000a",
            tenantId: "org:00000000-0000-4000-8000-00000000000b",
            scope: "user",
            role: null,
            // Personal-tenant sessions carry only account permissions: the
            // ops surface (org:read) DENIES them — the console's discipline.
            permissions:
              token === "operator-session-token"
                ? ["account:read", "account:manage", OPERATOR_PERMISSION]
                : ["account:read", "account:manage"],
          }),
        };
      },
    },
    slo: bindings,
  },
};

describe("RL-109 the /ops/slo fail-closed gate", () => {
  it("redirects anonymous requests to /login (never renders surface state)", async () => {
    const response = await handleOpsSloSurface(request(), runtime as never);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("redirects an unresolvable session to /login (the real principal read decides)", async () => {
    const response = await handleOpsSloSurface(
      request("roamlink_session=unknown-token"),
      runtime as never,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("renders the access-denied panel for a session without org:read (never partial data)", async () => {
    const response = await handleOpsSloSurface(
      request("roamlink_session=personal-session-token"),
      runtime as never,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-access-denied="true"');
    expect(html).toContain(`data-required-permission="${OPERATOR_PERMISSION}"`);
    expect(html).not.toContain("data-slo-dashboard"); // no surface state leaked
  });

  it("answers 503 HOST_NOT_READY when the composition refused to boot", async () => {
    const response = await handleOpsSloSurface(request(), {
      ok: false,
      error: new Error("composition refused"),
    } as never);
    expect(response.status).toBe(503);
  });
});

describe("RL-109 the /ops/slo surface renders REAL recorder state", () => {
  it("renders all nine §11 rows: budgeted ones with real numbers, the rest honestly not budgeted", async () => {
    // REAL events through the public recorder: 1 bad intent-satisfaction
    // event of 1 (exhausted) and all-good failover events (within-budget).
    bindings.recorder.recordIntentSatisfaction({
      tenantId: "org:ops",
      satisfied: false,
      at: clock.now(),
    });
    for (let index = 0; index < 9; index += 1) {
      bindings.recorder.recordProviderAccessFailover({
        tenantId: "org:ops",
        succeeded: true,
        at: clock.now(),
      });
    }

    const response = await handleOpsSloSurface(
      request("roamlink_session=operator-session-token"),
      runtime as never,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const id of [
      "time-to-usable-connectivity",
      "minutes-without-usable-connectivity",
      "manual-interventions-per-session-day",
      "successful-automatic-recovery-rate",
      "intent-satisfaction-rate",
      "connectivity-cost-per-useful-hour-gb-where-available",
      "stale-unknown-state-duration",
      "provider-access-failover-success",
      "support-incidents-attributable-to-connectivity-orchestration",
    ]) {
      expect(html).toContain(`data-slo-id="${id}"`);
    }
    // The budgeted rows carry their REAL evaluation state (data attributes
    // the smoke/verification reads; never prose-only).
    expect(html).toContain('data-slo-id="intent-satisfaction-rate" data-slo-state="exhausted"');
    expect(html).toContain(
      'data-slo-id="provider-access-failover-success" data-slo-state="within-budget"',
    );
    expect(html).toContain("0/1"); // the real event counts (one bad intent event)
    expect(html).toContain("9/9");
    // The unconfigured rows are honestly not budgeted (no fabricated state).
    expect(html).toContain('data-slo-id="stale-unknown-state-duration" data-slo-state="not-budgeted"');
    // Overall aggregation: one exhausted row degrades the surface.
    expect(html).toContain("degraded");
  });
});

describe("RL-109 the ROAMLINK_SLO_OBJECTIVES parser (fail closed)", () => {
  it("parses valid entries into typed objectives keyed by the closed §11 ids", () => {
    const objectives = parseSloObjectivesEnv(
      "intent-satisfaction-rate:0.99:86400000,provider-access-failover-success:0.999:604800000:0.5",
    );
    expect(objectives["intent-satisfaction-rate"]?.targetRatio).toBe(0.99);
    expect(objectives["intent-satisfaction-rate"]?.windowMs).toBe(86_400_000);
    expect(objectives["provider-access-failover-success"]?.atRiskBurnRate).toBe(0.5);
    // Unconfigured ids stay explicitly undefined (measured-only).
    expect(objectives["stale-unknown-state-duration"]).toBeUndefined();
  });

  it("answers an all-undefined map when the env is absent (measured-only everywhere)", () => {
    const objectives = parseSloObjectivesEnv(undefined);
    for (const id of Object.keys(objectives)) {
      expect(objectives[id as keyof typeof objectives]).toBeUndefined();
    }
  });

  it("refuses unknown ids, malformed entries and out-of-bounds numbers (never half-configured)", () => {
    expect(() => parseSloObjectivesEnv("no-such-slo:0.99:86400000")).toThrow(
      new RegExp(SLO_OBJECTIVES_ENV_KEY),
    );
    expect(() => parseSloObjectivesEnv("intent-satisfaction-rate:0.99")).toThrow(
      new RegExp(SLO_OBJECTIVES_ENV_KEY),
    );
    expect(() => parseSloObjectivesEnv("intent-satisfaction-rate:1.5:86400000")).toThrow(
      new RegExp(SLO_OBJECTIVES_ENV_KEY),
    );
    expect(() => parseSloObjectivesEnv("intent-satisfaction-rate:0.99:not-a-number")).toThrow(
      new RegExp(SLO_OBJECTIVES_ENV_KEY),
    );
  });
});
