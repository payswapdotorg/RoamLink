/**
 * The standalone schedule-publishing setup step (PA-025).
 *
 * Publishes the RECURRING QStash delivery of the bounded worker-tick job to
 * the receiver URL (the provider's pinned schedule API — the minimal
 * recurring-delivery surface in @roamlink/provider-qstash). Idempotent by
 * read-then-create: an existing schedule with the SAME destination + cron
 * is REPORTED and skipped, never duplicated.
 *
 * Environment contract (all values env-only; nothing is committed,
 * RL-LOCK-016): the FULL QStash env is validated before anything is
 * published (the same fail-closed validation as every QStash consumer —
 * a schedule delivered to a receiver whose signing keys are not configured
 * would burn the message budget on unverified 401s, so the setup path
 * refuses to publish into a half-wired deployment):
 *   QSTASH_TOKEN                     the publish credential (required)
 *   QSTASH_CURRENT_SIGNING_KEY       the receiver-side verification key
 *                                    (required — configured on the HOST)
 *   QSTASH_NEXT_SIGNING_KEY          optional rotation key
 *   QSTASH_URL                       optional endpoint override
 *   ROAMLINK_WORKER_TICK_DESTINATION the HTTPS receiver URL — the deployed
 *                                    host's /api/worker/tick route (required)
 *   ROAMLINK_WORKER_TICK_CRON        the 5-field cron cadence (required)
 *
 * Cadence law (spec/deployment.md §8): the cron expression is the OPERATOR's
 * budgeted choice — the Upstash free tier's ~1,000 messages/day is a
 * deployment fact to respect with headroom (an every-five-minutes cadence
 * fires 288/day), NEVER a correctness fact encoded here: the receiver
 * executes ONE bounded, idempotent tick per delivery, so any cadence is
 * safe.
 *
 * Exit codes are DISTINCT (the adcos-probe discipline):
 *   0  published (or already present — the idempotent skip)
 *   1  configuration refused (missing/invalid env keys)
 *   2  provider error (the schedule API rejected/failed the request)
 *
 * Run: `pnpm --filter @roamlink/worker-endpoint schedule:publish`
 */
// The RUNTIME-clean subpath: this is a standalone operator script (run
// under tsx/node, never under vitest) — the package's root export carries
// the vitest-dependent contract battery for the TEST plane and cannot be
// imported outside a vitest run.
import { tryParseQStashEnv, UpstashQStashClient } from "@roamlink/provider-qstash/runtime";

const EXIT = { published: 0, refused: 1, providerError: 2 } as const;

/** The closed job body the schedule delivers on every fire (byte-exact). */
const TICK_JOB_BODY = JSON.stringify({ kind: "worker.tick" });

const destination = process.env["ROAMLINK_WORKER_TICK_DESTINATION"];
const cron = process.env["ROAMLINK_WORKER_TICK_CRON"];

function refuse(message: string): never {
  console.log(JSON.stringify({ status: "refused", reason: message }, null, 2));
  process.exit(EXIT.refused);
}

if (destination === undefined || destination.trim().length === 0) {
  refuse("ROAMLINK_WORKER_TICK_DESTINATION is required (the HTTPS receiver URL of the deployed worker tick endpoint)");
}
if (cron === undefined || cron.trim().length === 0) {
  refuse("ROAMLINK_WORKER_TICK_CRON is required (the 5-field cron cadence; a budgeted operator choice, never a correctness fact)");
}

const parsed = tryParseQStashEnv(process.env);
if (!parsed.ok) {
  refuse(`the QStash environment is not configured: ${parsed.error.message}`);
}

const client = new UpstashQStashClient({
  token: parsed.ok ? parsed.config.token : "",
  ...(parsed.ok && parsed.config.baseUrl !== null ? { baseUrl: parsed.config.baseUrl } : {}),
});

try {
  // The idempotent-setup read: an identical destination+cron schedule is
  // reported and skipped, never duplicated.
  const existing = await client.listSchedules();
  const duplicate = existing.find(
    (listing) => listing.destination === destination && listing.cron === cron,
  );
  if (duplicate !== undefined) {
    console.log(
      JSON.stringify(
        {
          status: "already-present",
          scheduleId: duplicate.scheduleId,
          destination,
          cron,
          note: "an identical recurring delivery exists; nothing was created (idempotent setup)",
        },
        null,
        2,
      ),
    );
    process.exit(EXIT.published);
  }

  const schedule = await client.createSchedule({
    destination,
    cron,
    body: TICK_JOB_BODY,
  });
  console.log(
    JSON.stringify(
      {
        status: "published",
        scheduleId: schedule.scheduleId,
        destination,
        cron,
        body: TICK_JOB_BODY,
        note: "the receiver verifies every scheduled delivery's signature before acting (QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY on the host)",
      },
      null,
      2,
    ),
  );
  process.exit(EXIT.published);
} catch (error) {
  console.log(
    JSON.stringify(
      {
        status: "provider-error",
        reason: error instanceof Error ? error.message : "the schedule API failed (details suppressed)",
      },
      null,
      2,
    ),
  );
  process.exit(EXIT.providerError);
}
