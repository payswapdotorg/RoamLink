/**
 * The recurring-delivery (schedule) surface (PA-025) — the minimal schedule
 * port the live command-execution path's setup step needs: publish the
 * recurring delivery of the bounded worker tick job to the receiver URL.
 *
 * Wire contract (QStash v2 schedules API — single-site pin, the same
 * discipline as the publish API):
 *  - `POST {baseUrl}/v2/schedules/{destination}` with
 *    `Authorization: Bearer <token>` and the JSON body
 *    `{"cron": "<5-field cron>", "body": "<the delivered body>"}` — the
 *    destination rides the path with its scheme LITERAL (the same law as
 *    the publish route); the optional `body` is delivered byte-exact on
 *    every scheduled fire (the receiver's signature verification covers
 *    exactly it);
 *  - success: 200/201 + `{"scheduleId": "<id>"}`; failure: the same typed
 *    {@link QStashProviderError} phases as the publish client (provider
 *    text SUPPRESSED, RL-LOCK-016);
 *  - `GET {baseUrl}/v2/schedules` lists the existing schedules (the
 *    idempotent-setup read: the setup script skips creating a duplicate
 *    when an identical destination+cron schedule already exists). The
 *    provider's list entries carry the schedule's own fields; this port
 *    parses DEFENSIVELY (only scheduleId/destination/topic/cron are read,
 *    unknown fields ignored) because the exact live response shape for
 *    these auxiliary fields has NOT yet been captured the way the PA-017
 *    evidence pinned the publish/verify routes — the create path above is
 *    the load-bearing wire, and its drift would be a contained, single-site
 *    fix (the ADR-0003 replacement rule keeps the fake the contract
 *    reference until the operator's live confirmation run).
 *
 * Law (spec/deployment.md §8): schedules are TRANSPORT cadence, never
 * correctness — the receiver executes ONE bounded, idempotent tick per
 * delivery, so any cadence (or a duplicate schedule) is safe; free-tier
 * message budgets shape the operator's cadence CHOICE, never the code.
 */
import { ValidationError, type ErrorDetail } from "@roamlink/contracts";

/** The recurring-delivery request: where and when to deliver the body. */
export interface RecurringDeliveryScheduleRequest {
  /** HTTPS receiver URL (the endpoint that will VERIFY the signature). */
  readonly destination: string;
  /** The 5-field cron expression (the provider's own cadence law). */
  readonly cron: string;
  /** The BYTE-EXACT body every scheduled delivery carries (optional). */
  readonly body?: string;
}

/** A published recurring delivery (the transport's schedule handle). */
export interface RecurringDeliverySchedule {
  readonly scheduleId: string;
}

/** A listed schedule entry (defensively parsed; see the module doc). */
export interface RecurringDeliveryScheduleListing {
  readonly scheduleId: string;
  readonly destination: string | null;
  readonly cron: string | null;
}

/** The minimal schedule port (PA-025): publish + list, nothing more. */
export interface DurableJobSchedulePort {
  /** Publishes (creates) the recurring delivery. */
  createSchedule(request: RecurringDeliveryScheduleRequest): Promise<RecurringDeliverySchedule>;
  /** Lists the existing schedules (the idempotent-setup read). */
  listSchedules(): Promise<readonly RecurringDeliveryScheduleListing[]>;
}

/** The cron grammar bound: 5 space-separated fields, bounded length. */
const CRON_FIELD_PATTERN = /^\S+ \S+ \S+ \S+ \S+$/;

function issue(path: string, problem: string): ErrorDetail {
  return { path, issue: problem };
}

/** Validates a cron expression's minimal shape (the provider owns the rest). */
export function validateCronExpression(cron: string): string {
  if (typeof cron !== "string" || cron.length === 0 || cron.length > 100 || !CRON_FIELD_PATTERN.test(cron)) {
    throw new ValidationError(
      "schedule cron expressions must be 5 space-separated fields (minute hour day month weekday); the provider owns the remaining semantics",
      {
        reason: "SCHEDULE_CRON_INVALID",
        details: [issue("cron", "not a 5-field cron expression")],
      },
    );
  }
  return cron;
}
