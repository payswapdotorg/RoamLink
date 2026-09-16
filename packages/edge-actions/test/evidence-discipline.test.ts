/**
 * RL-043 evidence-discipline tests: a local action CANNOT claim physical
 * success without platform/ADCOS evidence (RL-LOCK-011, spec/mobile.md
 * honesty rules). These are failing-capable tests: they fail when an
 * implementation admits a success-without-evidence anywhere on the path
 * (RL-LOCK-018).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { DeviceActionResult } from "@roamlink/edge";

import {
  DeviceActionAdapter,
  InMemoryDeviceActionProjectionStore,
  InMemoryPlatformActionExecutor,
  parsePlatformExecutionOutcome,
  type PlatformActionExecutor,
  type PlatformExecutionOutcome,
} from "../src/index.js";
import { actionRequest, snapshot, succeedingExecutor, T0 } from "./helpers.js";

const EVIDENCE = { kind: "platform-api-probe", source: "TestProbe.framework" } as const;

describe("the RL-040 result contract itself rejects fabricated success", () => {
  it("executed-observed without evidence is a typed contract violation", () => {
    expect(
      () =>
        new DeviceActionResult({
          actionId: "00000000-0000-4000-8000-0000000000aa",
          status: "executed-observed",
          completedAt: T0,
        }),
    ).toThrowError(/REQUIRES platform evidence/);
  });

  it("executed-observed with kind 'none' evidence is a typed contract violation", () => {
    expect(
      () =>
        new DeviceActionResult({
          actionId: "00000000-0000-4000-8000-0000000000aa",
          status: "executed-observed",
          completedAt: T0,
          evidence: { kind: "none" },
        }),
    ).toThrowError(/kind 'none'/);
  });

  it("server-authoritative results must satisfy the same honesty rules", () => {
    expect(() =>
      DeviceActionResult.fromPlain({
        actionId: "00000000-0000-4000-8000-0000000000ab",
        status: "executed-observed",
        completedAt: T0,
      }),
    ).toThrowError(/REQUIRES platform evidence/);
  });
});

describe("parsePlatformExecutionOutcome (the seam contract)", () => {
  it("accepts an evidenced success and freezes it", () => {
    const outcome = parsePlatformExecutionOutcome({
      outcome: "succeeded",
      evidence: EVIDENCE,
    });
    expect(outcome).toEqual({ outcome: "succeeded", evidence: EVIDENCE });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("rejects success without evidence (fail-closed, RL-LOCK-011)", () => {
    expect(() => parsePlatformExecutionOutcome({ outcome: "succeeded" })).toThrowError(
      /REQUIRES platform evidence/,
    );
    expect(() =>
      parsePlatformExecutionOutcome({ outcome: "succeeded", evidence: { kind: "none" } }),
    ).toThrowError(/kind 'none' evidence - success without real evidence/);
  });

  it("rejects non-success outcomes without a closed-vocabulary reason", () => {
    expect(() => parsePlatformExecutionOutcome({ outcome: "failed" })).toThrowError(
      /closed executor reason vocabulary/,
    );
    expect(() =>
      parsePlatformExecutionOutcome({ outcome: "failed", reason: "not-a-reason" }),
    ).toThrowError(/closed executor reason vocabulary/);
    expect(() =>
      parsePlatformExecutionOutcome({ outcome: "exploded", reason: "execution-failed" }),
    ).toThrowError(/one of succeeded, failed, requires-guidance, unsupported/);
    expect(() =>
      parsePlatformExecutionOutcome({ outcome: "failed", reason: "execution-failed", extra: 1 }),
    ).toThrowError(/unknown field/);
  });

  it("rejects an oversized or control-character detail (RL-LOCK-016)", () => {
    expect(() =>
      parsePlatformExecutionOutcome({
        outcome: "failed",
        reason: "execution-failed",
        detail: "x".repeat(257),
      }),
    ).toThrowError(/bounded/);
    expect(() =>
      parsePlatformExecutionOutcome({
        outcome: "failed",
        reason: "execution-failed",
        detail: "bad\u0007",
      }),
    ).toThrowError(/bounded/);
  });
});

describe("the adapter never claims success without evidence", () => {
  function adapterWith(executor: PlatformActionExecutor): DeviceActionAdapter {
    return new DeviceActionAdapter({
      capabilitySnapshotProvider: () => snapshot(),
      executor,
      projection: new InMemoryDeviceActionProjectionStore(),
    });
  }

  it("a non-conforming executor success (no evidence) becomes a typed failure, never an executed claim", async () => {
    const executor: PlatformActionExecutor = {
      executorId: "buggy-executor",
      execute: async () =>
        ({ outcome: "succeeded", evidence: { kind: "none" } }) as unknown as PlatformExecutionOutcome,
    };
    const result = await adapterWith(executor).execute(actionRequest(), T0);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("execution-failed");
    expect(result.detail).toMatch(/refusing to claim physical success/);
    expect(result.evidence).toBeUndefined();
  });

  it("a non-conforming executor success (missing evidence field) becomes a typed failure", async () => {
    const executor: PlatformActionExecutor = {
      executorId: "buggy-executor",
      execute: async () => ({ outcome: "succeeded" }) as unknown as PlatformExecutionOutcome,
    };
    const result = await adapterWith(executor).execute(actionRequest(), T0);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("execution-failed");
  });

  it("a throwing executor is a suppressed, typed failure (RL-LOCK-016)", async () => {
    const executor: PlatformActionExecutor = {
      executorId: "throwing-executor",
      execute: async () => {
        throw new Error("secret-laden platform failure");
      },
    };
    const result = await adapterWith(executor).execute(actionRequest(), T0);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("execution-failed");
    expect(result.detail).not.toContain("secret-laden");
    expect(result.detail).toMatch(/suppressed/);
  });

  it("an evidenced executor success produces exactly one executed-observed claim", async () => {
    const executor = new InMemoryPlatformActionExecutor({
      capabilities: [
        {
          capability: "wifi_control",
          script: [
            InMemoryPlatformActionExecutor.evidencedSuccess({ ...EVIDENCE, detail: "joined" }),
          ],
        },
      ],
    });
    const result = await adapterWith(executor).execute(actionRequest(), T0);
    expect(result.status).toBe("executed-observed");
    expect(result.evidence?.kind).toBe("platform-api-probe");
    expect(result.reason).toBeUndefined();
  });

  it("the fake executor itself refuses to script an evidence-less success (fail-closed construction)", () => {
    expect(
      () =>
        new InMemoryPlatformActionExecutor({
          capabilities: [
            {
              capability: "wifi_control",
              script: [{ outcome: "succeeded", evidence: { kind: "none" } }],
            },
          ],
        }),
    ).toThrowError(/kind 'none' evidence|REQUIRES platform evidence/);
  });

  it("a requires-guidance executor outcome degrades (never fabricates success)", async () => {
    const executor = new InMemoryPlatformActionExecutor({
      capabilities: [
        {
          capability: "wifi_control",
          script: [
            { outcome: "requires-guidance", reason: "capability-requires-permission" },
          ],
        },
      ],
    });
    const result = await adapterWith(executor).execute(actionRequest(), T0);
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("capability-requires-permission");
  });

  it("an executor-unsupported capability is typed-unsupported through the adapter", async () => {
    // The gate admits (evidence available), but the platform adapter has no
    // implementation: still never a guess.
    const executor = new InMemoryPlatformActionExecutor({ capabilities: [] });
    const result = await adapterWith(executor).execute(
      actionRequest({ capability: "active_interface_selection", seed: 7 }),
      T0,
    );
    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("action-unsupported");
  });

  it("ValidationError detail from the adapter is value-free (RL-LOCK-016)", () => {
    let observed = "";
    try {
      parsePlatformExecutionOutcome({ outcome: "succeeded", evidence: { kind: "nope" } });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      observed = (error as ValidationError).message;
    }
    expect(observed).not.toContain("nope");
  });

  it("succeeding test helper executor produces honest success for replay tests", async () => {
    const result = await adapterWith(succeedingExecutor()).execute(actionRequest(), T0);
    expect(result.status).toBe("executed-observed");
  });
});
