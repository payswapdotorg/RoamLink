/**
 * The reconciliation scheduler (RL-035, spec §7 "periodically").
 * Deterministic manual timer - no ambient clocks anywhere.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import { AdcosReconciliationScheduler, SystemReconciliationTimer } from "../src/index.js";
import type { ReconciliationJobRecord, ReconciliationJobRequest } from "../src/index.js";

class ManualTimer {
  readonly scheduled: { readonly callback: () => void; readonly delayMs: number }[] = [];
  private cancelled = new Set<() => void>();

  schedule(callback: () => void, delayMs: number): () => void {
    const entry = { callback, delayMs };
    this.scheduled.push(entry);
    const cancel = () => {
      const index = this.scheduled.indexOf(entry);
      if (index >= 0) this.scheduled.splice(index, 1);
      this.cancelled.add(cancel);
    };
    return cancel;
  }

  /** Fires all pending callbacks in scheduling order and clears the queue. */
  fire(): void {
    const pending = [...this.scheduled];
    this.scheduled.length = 0;
    for (const entry of pending) entry.callback();
  }
}

function makeRunner(): {
  runner: { runJob(request: ReconciliationJobRequest): Promise<ReconciliationJobRecord> };
  requests: ReconciliationJobRequest[];
} {
  const requests: ReconciliationJobRequest[] = [];
  return {
    requests,
    runner: {
      runJob: async (request) => {
        requests.push(request);
        return { status: "COMPLETED" } as ReconciliationJobRecord;
      },
    },
  };
}

function jobRecordOf(overrides: Partial<ReconciliationJobRecord>): ReconciliationJobRecord {
  return {
    job_id: "00000000-0000-4000-8000-000000000001",
    correlation_id: "corr-1",
    idempotency_key: "idem.reconcile-job.00000000-0000-4000-8000-000000000001",
    actor_id: "actor:reconciliation-engine",
    tenant_id: "org:00000000-0000-4000-8000-000000000001",
    created_at: "2026-01-15T08:30:00.000Z",
    retry: { attempt: 1 },
    trigger_reason: "scheduled",
    status: "COMPLETED",
    started_at: "2026-01-15T08:30:00.000Z",
    completed_at: "2026-01-15T08:30:00.000Z",
    actions: [],
    summary: null,
    ...overrides,
  } as ReconciliationJobRecord;
}

describe("the reconciliation scheduler", () => {
  it("runs one scheduled job per fired interval tick", async () => {
    const timer = new ManualTimer();
    const { runner, requests } = makeRunner();
    const scheduler = new AdcosReconciliationScheduler({
      reconciler: runner,
      intervalMs: 60_000,
      timer,
    });
    const schedule = scheduler.start();
    expect(requests).toHaveLength(0); // first run happens after one interval

    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the tick settle
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reason).toBe("scheduled");

    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    schedule.stop();
  });

  it("runNow executes a job immediately and awaitably", async () => {
    const timer = new ManualTimer();
    const { runner, requests } = makeRunner();
    const scheduler = new AdcosReconciliationScheduler({
      reconciler: runner,
      intervalMs: 60_000,
      timer,
    });
    await scheduler.runNow();
    expect(requests).toHaveLength(1);
  });

  it("stop() cancels the pending tick", async () => {
    const timer = new ManualTimer();
    const { runner, requests } = makeRunner();
    const scheduler = new AdcosReconciliationScheduler({
      reconciler: runner,
      intervalMs: 60_000,
      timer,
    });
    const schedule = scheduler.start();
    schedule.stop();
    timer.fire(); // nothing was armed after stop
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);
  });

  it("a failing job NEVER stops the schedule; the failure is surfaced", async () => {
    const timer = new ManualTimer();
    const requests: ReconciliationJobRequest[] = [];
    let calls = 0;
    const errors: unknown[] = [];
    const runner = {
      runJob: async (request: ReconciliationJobRequest): Promise<ReconciliationJobRecord> => {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          throw new ValidationError("simulated job failure", { reason: "JOB_FAILED_ONCE" });
        }
        return jobRecordOf({});
      },
    };
    const scheduler = new AdcosReconciliationScheduler({
      reconciler: runner,
      intervalMs: 1_000,
      timer,
      onJobError: (error) => errors.push(error),
    });
    scheduler.start();

    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as ValidationError).reason).toBe("JOB_FAILED_ONCE");

    timer.fire(); // the schedule survived the failure
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(errors).toHaveLength(1);
    scheduler.stop();
  });

  it("extra request fields flow into scheduled runs", async () => {
    const timer = new ManualTimer();
    const { runner, requests } = makeRunner();
    const scheduler = new AdcosReconciliationScheduler({
      reconciler: runner,
      intervalMs: 60_000,
      timer,
      request: { correlationId: "corr-scheduled-reconciliation" },
    });
    scheduler.start();
    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests[0]?.correlationId).toBe("corr-scheduled-reconciliation");
    expect(requests[0]?.reason).toBe("scheduled");
    scheduler.stop();
  });

  it("rejects an invalid interval", () => {
    const timer = new ManualTimer();
    const { runner } = makeRunner();
    expect(
      () =>
        new AdcosReconciliationScheduler({
          reconciler: runner,
          intervalMs: 0,
          timer,
        }),
    ).toThrow(ValidationError);
  });

  it("the system timer schedules and cancels through setTimeout", () => {
    const systemTimer = new SystemReconciliationTimer();
    let fired = false;
    const cancel = systemTimer.schedule(() => {
      fired = true;
    }, 5);
    cancel();
    expect(fired).toBe(false); // cancelled before firing
  });
});
