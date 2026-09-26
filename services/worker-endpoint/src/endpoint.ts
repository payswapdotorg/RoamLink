/**
 * The authenticated bounded worker-tick ENDPOINT (PA-025 — the live
 * command-execution path).
 *
 * The sanctioned topology (spec/deployment.md §3/§4) closes here:
 *
 *   Neon durable outbox
 *     -> QStash (the recurring scheduled delivery)
 *       -> THIS endpoint (signature-verified, bounded)
 *         -> the services/workers execution seam (createBoundedWorkerTick
 *            over commandLedgerDeliveryPort + createCommandLedger)
 *           -> executed-stage CAS writes + outbox outcome commits
 *             -> the read models serve REAL projections
 *
 * THE BOUND LAW: this is a REQUEST HANDLER, not a worker process — every
 * invocation executes exactly ONE bounded tick (one recoverInFlight sweep +
 * one capped claimDue batch through the delivery/outcome path + one bounded
 * inbox batch) and RETURNS. The tick's own max-duration guard stops a batch
 * that would exceed the budget after the current item (the un-attempted
 * remainder strands safely in DELIVERING and the next scheduled delivery's
 * sweep re-owns it). The SAME seam stays usable by the production
 * long-running host unchanged (services/workers main.ts).
 *
 * RECEIVER LAW (RL-097 discipline — mirrors the webhook-inbox rigor and the
 * maintenance receiver, RL-110):
 *  1. FAIL-CLOSED CONFIGURATION: without the receiver-side signing keys the
 *     endpoint answers 503 and NEVER acts (an unverified mutation surface
 *     is never acceptable);
 *  2. VERIFY BEFORE ACTING: the signature header is verified in constant
 *     time against the current (then rotation) key; ANY verification
 *     failure (unsigned, wrong key, outside the replay window, oversized,
 *     malformed) answers the fail-closed 401 with the closed, value-free
 *     code — the sweep/tick NEVER runs;
 *  3. the payload is the schedule's own job shape {kind: "worker.tick"}; an
 *     unreadable payload or an unknown kind is the typed 400 (the transport
 *     retries/dead-letters — never silent);
 *  4. the 2xx answer is the tick's honest outcome summary — observability
 *     only (counts and honest skips), never business state;
 *  5. a tick FAILURE answers 500 with suppressed details so the retryable
 *     path stays live (the claim/outcome discipline is crash-safe: the next
 *     delivery's sweep re-owns any stranded claim).
 */
import type { UtcInstant } from "@roamlink/contracts";
import type { PostgresPersistence } from "@roamlink/persistence-postgres";
// The RUNTIME-clean subpath: the endpoint is a deployed request handler —
// its bundle must never transitively import the vitest-dependent contract
// battery the package's root export carries for the TEST plane.
import {
  QSTASH_SIGNATURE_HEADER,
  QStashSignatureVerifier,
} from "@roamlink/provider-qstash/runtime";
import {
  commandLedgerDeliveryPort,
  createBoundedWorkerTick,
  createCommandLedger,
  type BoundedWorkerTick,
  type WorkerTickReport,
  type WebhookInboxDrainSource,
} from "@roamlink/workers";

import { createDemoCommandExecutors } from "./executors.js";

/** The closed job-kind vocabulary the receiver acts on (the schedule's body). */
export const WORKER_TICK_JOB_KIND = "worker.tick" as const;

export interface WorkerTickEndpointOptions {
  /**
   * The host's REAL persistence (the SAME database the API plane durably
   * accepted commands and outbox obligations into — one truth; the
   * transactional outbox is atomic with the command record by construction).
   */
  readonly persistence: PostgresPersistence;
  readonly now: () => UtcInstant;
  /**
   * The receiver-side QStash signing keys (QSTASH_CURRENT_SIGNING_KEY /
   * QSTASH_NEXT_SIGNING_KEY): absent current key -> every delivery is
   * answered the honest 503 and NEVER acted on (fail-closed).
   */
  readonly signingKeys: {
    readonly current: string | undefined;
    readonly next?: string | undefined;
  };
  /** The runtime mode (mirrors the host's; honest env composition only). */
  readonly mode?: "production" | "development";
  /** Bounded claim per tick (default 10; the tick's own law applies). */
  readonly outboxBatchSize?: number;
  /** The max-duration guard in ms (default 45s; the tick's own law applies). */
  readonly maxDurationMs?: number;
  /** Bounded inbox batch per tick (default 50). */
  readonly inboxBatchLimit?: number;
  /**
   * The webhook inbox drain source (ONE bounded projection batch per tick),
   * when the composing host also bound a projector. Absent -> the tick's
   * honest skip.
   */
  readonly inbox?: WebhookInboxDrainSource;
  /** Resource-id seam for the demo executor table (determinism in tests). */
  readonly newResourceId?: () => string;
}

/** The endpoint's closed answer vocabulary (value-free; observability only). */
export type WorkerTickEndpointResponse =
  | { readonly kind: typeof WORKER_TICK_JOB_KIND } & WorkerTickReport
  | { readonly reason: string };

export interface WorkerTickEndpoint {
  /** Handles one signed scheduled delivery (a Web-standard Request). */
  handle(request: Request): Promise<Response>;
  /** The composed bounded tick (observability/tests; one execute per handle). */
  readonly tick: BoundedWorkerTick;
}

/**
 * Builds the authenticated bounded worker-tick endpoint. The verifier is
 * composed ONCE (the pinned signature scheme lives in provider-qstash); the
 * tick composes the SAME execution seam the production host uses.
 */
export function createWorkerTickEndpoint(options: WorkerTickEndpointOptions): WorkerTickEndpoint {
  const verifier =
    options.signingKeys.current === undefined || options.signingKeys.current.length === 0
      ? undefined
      : new QStashSignatureVerifier({
          currentSigningKey: options.signingKeys.current,
          ...(options.signingKeys.next !== undefined && options.signingKeys.next.length > 0
            ? { nextSigningKey: options.signingKeys.next }
            : {}),
        });

  // --- the execution seam (exactly the production workers' composition) ---
  const ledger = createCommandLedger({ persistence: options.persistence });
  const executors = createDemoCommandExecutors(
    options.newResourceId !== undefined ? { newResourceId: options.newResourceId } : {},
  );
  const delivery = commandLedgerDeliveryPort({ executors, ledger, now: options.now });
  const tick = createBoundedWorkerTick(
    {
      mode: options.mode ?? "development",
      databaseUrl: undefined, // the persistence seam is provided (host-mounted)
      ...(options.outboxBatchSize !== undefined ? { outboxBatchSize: options.outboxBatchSize } : {}),
      ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
      ...(options.inboxBatchLimit !== undefined ? { inboxBatchLimit: options.inboxBatchLimit } : {}),
    },
    {
      persistence: options.persistence,
      delivery,
      now: options.now,
      ...(options.inbox !== undefined ? { inbox: options.inbox } : {}),
    },
  );

  return {
    tick,
    async handle(request: Request): Promise<Response> {
      // 1. Fail-closed configuration: an unverified mutation surface is
      //    never acceptable (mirrors the maintenance receiver's law).
      if (verifier === undefined) {
        return jsonResponse(503, {
          reason:
            "the worker tick endpoint refuses every delivery: the receiver-side QStash signing keys are not configured (fail-closed; QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY)",
        });
      }
      // 2. The byte-exact raw body (the signature covers exactly it).
      let rawBody: string;
      try {
        rawBody = await request.text();
      } catch {
        return jsonResponse(400, { reason: "the delivery body could not be read" });
      }
      // 3. VERIFY BEFORE ACTING — the tick NEVER runs on an unverified
      //    delivery (constant-time compare, replay window both directions,
      //    closed value-free failure codes).
      const verification = verifier.verify({
        signatureHeader: request.headers.get(QSTASH_SIGNATURE_HEADER) ?? undefined,
        body: rawBody,
        receivedAtMs: Date.parse(options.now()),
      });
      if (!verification.ok) {
        return jsonResponse(401, { reason: `signature verification failed (${verification.code})` });
      }
      // 4. The schedule's own job shape: exactly the closed tick kind.
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody) as unknown;
      } catch {
        return jsonResponse(400, { reason: "the delivery payload is not readable JSON" });
      }
      const kind = payload === null || typeof payload !== "object" ? undefined : (payload as Record<string, unknown>)["kind"];
      if (kind !== WORKER_TICK_JOB_KIND) {
        return jsonResponse(400, {
          reason: `the delivery payload must carry kind: ${WORKER_TICK_JOB_KIND} (the closed worker-tick job vocabulary)`,
        });
      }
      // 5. ONE bounded tick, then return (the bound law).
      try {
        const report = await tick.execute();
        return jsonResponse(200, { kind: WORKER_TICK_JOB_KIND, ...report });
      } catch {
        // The tick failed (database unreachable, composition refused...):
        // honest 500 with suppressed details; the transport retries and the
        // crash-safe claim discipline re-owns any stranded claim.
        return jsonResponse(500, {
          reason: "the bounded worker tick failed (details suppressed); the transport will retry",
        });
      }
    },
  };
}

function jsonResponse(status: number, body: WorkerTickEndpointResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
