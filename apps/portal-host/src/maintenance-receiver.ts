/**
 * The event-driven maintenance RECEIVER (RL-110).
 *
 * The /api/maintenance/daily cron trigger KICKS the recovery sweeps — and
 * when the QStash env is configured it kicks them EVENT-DRIVEN: the sweeps
 * are enqueued as durable jobs (`maintenance.outbox-sweep` /
 * `maintenance.inbox-drain`) to ROAMLINK_MAINTENANCE_DESTINATION. THIS
 * module is the receiver those jobs are delivered to: the endpoint that
 * VERIFIES the QStash signature and executes the SAME bounded sweeps the
 * inline trigger would (one sweep per delivery, never a long-running job —
 * spec/deployment.md §5).
 *
 * Receiver law (RL-097 discipline — mirrors webhook-inbox rigor):
 *  1. FAIL-CLOSED CONFIGURATION: without the receiver-side signing keys
 *     (QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY) the receiver
 *     answers 503 RECEIVER_NOT_CONFIGURED and NEVER acts (an unverified
 *     mutation surface is never acceptable — the honest not-configured is
 *     reported, never a faked trigger);
 *  2. VERIFY BEFORE ACTING: the signature header is verified in constant
 *     time against the current (then next) signing key; a failed
 *     verification answers 401 and the sweep NEVER runs;
 *  3. the payload is the trigger's own job shape {kind, at, limit?}; an
 *     unreadable payload or an unknown kind is a typed 400 (the transport
 *     retries/dead-letters — never silent);
 *  4. the sweeps are the LANDED public ports only: outbox
 *     `recoverInFlight(at)` (AR-007/RL-093) and the bounded inbox
 *     `processPending(limit)` (AR-008/RL-094 batch progression);
 *  5. 2xx acknowledges the job (QStash stops retrying); failures answer
 *     honestly so the retryable path stays live.
 */
import type { UnitOfWorkFactory, PersistenceReader } from "@roamlink/persistence";
import type { UtcInstant } from "@roamlink/contracts";
import { parseUtcInstant } from "@roamlink/contracts";
import {
  QSTASH_SIGNATURE_HEADER,
  QStashSignatureVerifier,
} from "@roamlink/provider-qstash";

import type { MaintenanceInboxSource } from "./maintenance.js";

/** The job kinds the cron trigger enqueues (the closed receiver vocabulary). */
export const MAINTENANCE_JOB_KINDS = Object.freeze({
  outboxSweep: "maintenance.outbox-sweep",
  inboxDrain: "maintenance.inbox-drain",
} as const);

export interface MaintenanceReceiverOptions {
  /** Opens the unit of work the outbox sweep runs in. */
  readonly persistence: UnitOfWorkFactory & PersistenceReader;
  /** The webhook inbox drain (when a projector is composed in-process). */
  readonly inbox?: MaintenanceInboxSource | undefined;
  /** The receiver-side signing keys (fail-closed: absent -> refuse every delivery). */
  readonly signingKeys: {
    readonly current: string | undefined;
    readonly next?: string | undefined;
  };
  readonly now: () => UtcInstant;
  readonly inboxBatchLimit?: number;
}

/** The receiver's answers (closed, honest; the body never echoes secrets). */
export type MaintenanceReceiverResponse = {
  readonly status: number;
  readonly body:
    | { readonly kind: "maintenance.outbox-sweep"; readonly outbox: { readonly recovered: number } }
    | {
        readonly kind: "maintenance.inbox-drain";
        readonly inbox:
          | { readonly drained: false; readonly reason: string }
          | { readonly drained: true; readonly applied: number; readonly failed: number };
      }
    | { readonly reason: string };
};

export interface MaintenanceReceiver {
  /** Handles one signed job delivery (a Web-standard Request). */
  handle(request: Request): Promise<Response>;
}

/**
 * Builds the maintenance receiver. The verifier is composed ONCE (the
 * signature scheme is pinned in one place, provider-qstash); the sweeps run
 * through the same public persistence ports the inline trigger uses.
 */
export function createMaintenanceReceiver(options: MaintenanceReceiverOptions): MaintenanceReceiver {
  const verifier =
    options.signingKeys.current === undefined || options.signingKeys.current.length === 0
      ? undefined
      : new QStashSignatureVerifier({
          currentSigningKey: options.signingKeys.current,
          ...(options.signingKeys.next !== undefined && options.signingKeys.next.length > 0
            ? { nextSigningKey: options.signingKeys.next }
            : {}),
        });

  return {
    async handle(request: Request): Promise<Response> {
      if (verifier === undefined) {
        return jsonResponse(503, {
          reason:
            "the maintenance receiver refuses every delivery: the receiver-side QStash signing keys are not configured (fail-closed; QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY)",
        });
      }
      const signatureHeader = request.headers.get(QSTASH_SIGNATURE_HEADER) ?? undefined;
      let rawBody: string;
      try {
        rawBody = await request.text();
      } catch {
        return jsonResponse(400, { reason: "the delivery body could not be read" });
      }
      const verification = verifier.verify({
        signatureHeader,
        body: rawBody,
        receivedAtMs: Date.parse(options.now()),
      });
      if (!verification.ok) {
        // Value-free: the failure code is diagnosable, the body/keys never
        // leak (RL-LOCK-016).
        return jsonResponse(401, { reason: `signature verification failed (${verification.code})` });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody) as unknown;
      } catch {
        return jsonResponse(400, { reason: "the delivery payload is not readable JSON" });
      }
      const kind = readKind(payload);
      if (kind === undefined) {
        return jsonResponse(400, {
          reason: `the delivery payload must carry kind: ${Object.values(MAINTENANCE_JOB_KINDS).join(" | ")}`,
        });
      }

      if (kind === MAINTENANCE_JOB_KINDS.outboxSweep) {
        const at = readAt(payload, options.now);
        const unitOfWork = await options.persistence.begin();
        try {
          const recovered = (await unitOfWork.outbox.recoverInFlight(at)).length;
          await unitOfWork.commit();
          return jsonResponse(200, {
            kind,
            outbox: { recovered },
          });
        } catch (error) {
          await unitOfWork.rollback();
          throw error;
        }
      }

      // inboxDrain
      const limit = readLimit(payload) ?? options.inboxBatchLimit ?? 50;
      if (options.inbox === undefined) {
        return jsonResponse(200, {
          kind,
          inbox: {
            drained: false,
            reason: "no webhook inbox with a composed projector is bound in this process",
          },
        });
      }
      const report = await options.inbox.processPending(limit);
      return jsonResponse(200, {
        kind,
        inbox: { drained: true, applied: report.applied, failed: report.failed },
      });
    },
  };
}

function jsonResponse(status: number, body: MaintenanceReceiverResponse["body"]): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The closed job-kind vocabulary the receiver acts on. */
type MaintenanceJobKind = (typeof MAINTENANCE_JOB_KINDS)[keyof typeof MAINTENANCE_JOB_KINDS];

function readKind(payload: unknown): MaintenanceJobKind | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)["kind"];
  if (typeof value !== "string") return undefined;
  return (Object.values(MAINTENANCE_JOB_KINDS) as string[]).includes(value)
    ? (value as MaintenanceJobKind)
    : undefined;
}

function readAt(payload: unknown, fallback: () => UtcInstant): UtcInstant {
  if (payload === null || typeof payload !== "object") return fallback();
  const value = (payload as Record<string, unknown>)["at"];
  if (typeof value !== "string" || value.length === 0) return fallback();
  try {
    return parseUtcInstant(value);
  } catch {
    return fallback();
  }
}

function readLimit(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)["limit"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}
