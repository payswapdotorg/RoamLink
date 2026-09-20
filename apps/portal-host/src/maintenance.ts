/**
 * The daily maintenance trigger (RL-107).
 *
 * infra/deployment/vercel.json declares `GET /api/maintenance/daily`
 * (Hobby cron: once per day). This module is the THIN, AUTHENTICATED,
 * IDEMPOTENT trigger behind the route — it KICKS the recovery sweeps, it is
 * NOT a long-running job in a serverless route (spec/deployment.md §5):
 *
 *   - the OUTBOX SWEEP: `recoverInFlight(at)` re-owns every claim stranded
 *     in DELIVERING by a crash (AR-007/RL-093) so the worker's next claim
 *     continues them; a set-transition, idempotent by construction;
 *   - the INBOX DRAIN: ONE bounded `processPending` call when a webhook
 *     inbox with its projector is composed (the AR-008 batch progression
 *     makes repeated bounded kicks advance through any backlog);
 *   - EVENT-DRIVEN KICK (optional): when the QStash DurableJobDeliveryPort
 *     is composed with an explicit destination, the trigger instead
 *     enqueues the two sweeps as durable jobs with DETERMINISTIC, per-day
 *     job ids (`maintenance-daily-<yyyymmdd>-outbox` / `-inbox`) — cron
 *     retries are idempotent (RL-LOCK-014); QStash is never the business
 *     state, the receiver still executes the same bounded sweeps.
 *
 * AUTHENTICATION: the route answers ONLY requests bearing
 * `Authorization: Bearer <CRON_SECRET>` (Vercel cron delivers the secret
 * exactly this way). Without CRON_SECRET configured the route refuses ALL
 * triggers (fail-closed - an unauthenticated mutation surface is never
 * acceptable), with an honest error naming the missing configuration key.
 */
import { timingSafeEqual } from "node:crypto";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import type { UtcInstant } from "@roamlink/contracts";
import type { DurableJobDeliveryPort, JobEnqueueReceipt } from "@roamlink/provider-qstash";
import type { WebhookProcessingReport } from "@roamlink/webhook-inbox";

/** The inbox drain surface (the boundary's inbox service, when composed). */
export interface MaintenanceInboxSource {
  processPending(limit?: number): Promise<WebhookProcessingReport>;
}

export interface DailyMaintenanceOptions {
  readonly persistence: UnitOfWorkFactory & PersistenceReader;
  /** The webhook inbox drain (when a projector is composed in-process). */
  readonly inbox?: MaintenanceInboxSource | undefined;
  /** The QStash port (event-driven kick; optional). */
  readonly asyncDelivery?: DurableJobDeliveryPort | undefined;
  /** The receiver URL for the event-driven kick (required with asyncDelivery). */
  readonly asyncDestination?: string | undefined;
  readonly now: () => UtcInstant;
  readonly inboxBatchLimit?: number;
}

export type DailyMaintenanceResult =
  | {
      readonly mode: "inline";
      readonly outbox: { readonly recovered: number };
      readonly inbox:
        | { readonly drained: false; readonly reason: string }
        | { readonly drained: true; readonly report: WebhookProcessingReport };
    }
  | {
      readonly mode: "enqueued";
      readonly jobs: readonly {
        readonly jobId: string;
        readonly accepted: boolean;
        readonly duplicate: boolean;
      }[];
    };

/**
 * Runs the daily maintenance trigger (see the module doc). Bounded by
 * construction: one sweep + one bounded inbox call (or two job enqueues).
 */
export async function runDailyMaintenance(options: DailyMaintenanceOptions): Promise<DailyMaintenanceResult> {
  const at = options.now();

  if (options.asyncDelivery !== undefined) {
    if (options.asyncDestination === undefined || options.asyncDestination.trim().length === 0) {
      throw new Error(
        "the event-driven maintenance kick requires ROAMLINK_MAINTENANCE_DESTINATION (the HTTPS receiver URL)",
      );
    }
    const day = utcDateStamp(at);
    const jobs = await Promise.all([
      enqueueKick(options.asyncDelivery, options.asyncDestination, `maintenance-daily-${day}-outbox`, {
        kind: "maintenance.outbox-sweep",
        at,
      }),
      enqueueKick(options.asyncDelivery, options.asyncDestination, `maintenance-daily-${day}-inbox`, {
        kind: "maintenance.inbox-drain",
        at,
        ...(options.inboxBatchLimit !== undefined ? { limit: options.inboxBatchLimit } : {}),
      }),
    ]);
    return {
      mode: "enqueued",
      jobs,
    };
  }

  // Inline mode: one bounded sweep kick (NOT a long-running job).
  const unitOfWork = await options.persistence.begin();
  let recovered: number;
  try {
    recovered = (await unitOfWork.outbox.recoverInFlight(at)).length;
    await unitOfWork.commit();
  } catch (error) {
    await unitOfWork.rollback();
    throw error;
  }

  const inbox =
    options.inbox === undefined
      ? ({ drained: false, reason: "no webhook inbox with a composed projector is bound in this process" } as const)
      : ({ drained: true, report: await options.inbox.processPending(options.inboxBatchLimit ?? 50) } as const);

  return { mode: "inline", outbox: { recovered }, inbox };
}

async function enqueueKick(
  port: DurableJobDeliveryPort,
  destination: string,
  jobId: string,
  payload: Record<string, unknown>,
): Promise<{ readonly jobId: string; readonly accepted: boolean; readonly duplicate: boolean }> {
  const receipt: JobEnqueueReceipt = await port.enqueue({ jobId, destination, payload });
  return { jobId: receipt.jobId, accepted: receipt.accepted, duplicate: receipt.duplicate };
}

/** UTC `yyyymmdd` stamp for the deterministic per-day job ids. */
function utcDateStamp(at: UtcInstant): string {
  const date = new Date(at);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}${month}${day}`;
}

/**
 * The fail-closed cron authorization: ONLY `Authorization: Bearer
 * <CRON_SECRET>` is accepted, compared in constant time; a missing/blank
 * CRON_SECRET refuses every request (the route never triggers unauthenticated).
 */
export function isAuthorizedCronRequest(
  request: { readonly headers: { get(name: string): string | null } },
  cronSecret: string | undefined,
): boolean {
  if (cronSecret === undefined || cronSecret.length === 0) return false;
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match?.[1]?.trim();
  if (presented === undefined || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(cronSecret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
