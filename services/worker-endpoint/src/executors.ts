/**
 * The demo's composed command handlers (PA-025 — the live command-execution
 * path's executor table).
 *
 * These are the executors the bounded worker tick's delivery port composes
 * for the low-cost hosted demo: each one APPLIES its command kind and hands
 * the ledger the resource it created (the durable record the PA-019
 * command-ledger read projections project from — "a device exists from
 * execution"). The kinds WITHOUT a composed executor (the read-model-less
 * ones: orders, payments, notifications, eSIM, connector, support cases,
 * organizations...) keep the honest outbox law: RETRYABLE failure with the
 * diagnosable reason `COMMAND_EXECUTOR_NOT_COMPOSED` — a rolling deploy
 * that adds an executor self-heals them; they are never silently dropped
 * and never faked.
 *
 * Executor law (services/workers delivery.ts): an executor that THROWs is
 * an honest retryable attempt-failure (COMMAND_EXECUTION_FAILED — backoff,
 * budget, terminal FAILED when exhausted); returning a resource records it
 * in the ledger's `executed` CAS write. Validation here is the projection
 * plane's own fact law: the read models' `stringPayload`/`accessClassesPayload`
 * discipline fails closed on commands whose payloads lack the facts the
 * projections need, so the executor refuses them BEFORE the executed stage
 * is ever written (a command that would corrupt the ledger's projections
 * is never advanced).
 */
import { ValidationError } from "@roamlink/contracts";

import type { CommandExecutionOutcome, CommandExecutor } from "@roamlink/workers";

/** The seams the demo executor table composes over. */
export interface DemoCommandExecutorOptions {
  /**
   * Allocates the canonical resource ids execution creates (devices,
   * experience intents). Injectable for determinism in tests; defaults to
   * crypto.randomUUID — the id is allocated ONCE at execution and the
   * ledger's CAS makes every redelivery a no-op, so randomness never
   * duplicates a resource.
   */
  readonly newResourceId?: () => string;
}

/** The demo executor table: the kinds the hosted demo advances to executed. */
export function createDemoCommandExecutors(options: DemoCommandExecutorOptions = {}): Readonly<Record<string, CommandExecutor>> {
  const newResourceId = options.newResourceId ?? (() => crypto.randomUUID());

  return {
    // --- devices (the PA-019 device read projections) -----------------------
    "device.enroll": async (_record, payload): Promise<CommandExecutionOutcome | void> => {
      const body = requirePayloadObject("device.enroll", payload.payload);
      requireNonEmptyString("device.enroll", body, "name");
      requireNonEmptyString("device.enroll", body, "platform");
      // The enrolled device's durable record: the resource the projections
      // project (the device registry's creation state, revision 1).
      return { resource: { type: "device", id: newResourceId(), version: 1 } };
    },
    "device.update": async (_record, payload): Promise<CommandExecutionOutcome | void> => {
      const body = requirePayloadObject("device.update", payload.payload);
      // Optional facts, but present-then-non-empty (the projection law).
      if (body["name"] !== undefined) requireNonEmptyString("device.update", body, "name");
      if (body["platform"] !== undefined) requireNonEmptyString("device.update", body, "platform");
      return; // a targeted transition: no new resource
    },
    "device.retire": async (_record, payload): Promise<CommandExecutionOutcome | void> => {
      requirePayloadObject("device.retire", payload.payload);
      return; // a targeted transition: no new resource
    },

    // --- experience intents (the PA-019 intent read projections) -----------
    "experience-intent.create": async (_record, payload): Promise<CommandExecutionOutcome | void> => {
      const body = requirePayloadObject("experience-intent.create", payload.payload);
      requireNonEmptyString("experience-intent.create", body, "deviceId");
      requireNonEmptyString("experience-intent.create", body, "rationale");
      requireAccessClasses("experience-intent.create", body);
      // The created goal's durable record: the resource the projections
      // project (the intent service's creation state, revision 1).
      return { resource: { type: "experience_intent", id: newResourceId(), version: 1 } };
    },
    "experience-intent.activate": async (_record, payload): Promise<CommandExecutionOutcome | void> => {
      requirePayloadObject("experience-intent.activate", payload.payload);
      return; // a targeted transition: no new resource
    },
    "experience-intent.supersede": async (_record, payload): Promise<CommandExecutionOutcome | void> => {
      const body = requirePayloadObject("experience-intent.supersede", payload.payload);
      requireNonEmptyString("experience-intent.supersede", body, "rationale");
      requireAccessClasses("experience-intent.supersede", body);
      return; // the new immutable version projects from the command itself
    },
  };
}

// --------------------------------------------------------------------------------
// The projection-fact validation helpers (fail closed BEFORE the stage write)
// --------------------------------------------------------------------------------

function executorInvalid(kind: string, issue: string, path: string): never {
  throw new ValidationError(`the ${kind} execution refused the command before the executed stage: ${issue}`, {
    reason: "COMMAND_PAYLOAD_INVALID",
    details: [{ path, issue }],
  });
}

function requirePayloadObject(kind: string, payload: unknown): Record<string, unknown> {
  // The API plane stores the command payload as its CANONICAL JSON STRING
  // (the ingest's canonicalizeJson — the same storage shape the read
  // models parse back); the object form is also accepted (mirroring the
  // read models' defensive dual parse).
  let candidate: unknown = payload;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      executorInvalid(kind, "the command payload is not readable JSON", "$");
    }
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    executorInvalid(kind, "the command payload must be a JSON object", "$");
  }
  return candidate as Record<string, unknown>;
}

function requireNonEmptyString(kind: string, body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    executorInvalid(kind, `the command payload must carry ${field} as a non-empty string`, field);
  }
  return value as string;
}

function requireAccessClasses(kind: string, body: Record<string, unknown>): readonly string[] {
  const value = body["accessClasses"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    executorInvalid(kind, "the command payload must carry accessClasses as a non-empty array of strings", "accessClasses");
  }
  return value as readonly string[];
}
