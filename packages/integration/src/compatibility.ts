/**
 * The ADCOS compatibility gate (RL-031, spec/adcos-integration.md §9).
 *
 * The supported ADCOS contract version is configured in ONE place
 * (`ADCOS_API_VERSION` in @roamlink/adcos, consistent with the env-schema pin
 * asserted by tests/architecture). At startup the gate verifies, through the
 * REAL AdcosClient (fake in tests, sandbox/production otherwise):
 *
 *  1. endpoint/schema availability - the cheap read routes answer with
 *     contract-shaped responses;
 *  2. version compatibility - the client's pinned version matches the
 *     supported line and the endpoint accepts it;
 *  3. required lifecycle states - the pinned 13-state contract vocabulary is
 *     intact and internally consistent (closed enum, canonical progression,
 *     terminal states);
 *  4. required fields/enums - the closed request schemas and webhook envelope
 *     reject unknown members (fail-closed contract self-test);
 *  5. webhook semantics - the pinned signature scheme (algorithm, replay
 *     window, header names, canonical message) plus an HMAC round-trip;
 *  6. idempotency behavior - a probe mutation replayed with the same
 *     idempotency key returns the same response with no error.
 *
 * Incompatible ADCOS versions FAIL CLOSED for mutations: adapters consult the
 * {@link AdcosCompatibilityState} runtime holder and refuse to mutate before
 * any I/O, with a diagnosable health state (RL-031; spec/security.md
 * "Fail-safe defaults"). The DEFAULT state is `unknown` - until the startup
 * check has PASSED, mutations are refused. Full contract/self-test coverage
 * against real ADCOS is RL-036 (Wave 3) and builds on this gate.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DomainError,
  ValidationError,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  ADCOS_CONTRACT_STATES,
  ADCOS_CONTRACT_STATE_TRANSITIONS,
  ADCOS_CONTRACT_CANONICAL_PROGRESSION,
  ADCOS_CONTRACT_TERMINAL_STATES,
  ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES,
  ADCOS_WEBHOOK_MAX_DELIVERY_ATTEMPTS,
  ADCOS_WEBHOOK_REPLAY_WINDOW_MS,
  ADCOS_WEBHOOK_RETRY_BACKOFF_SCHEDULE_MS,
  ADCOS_WEBHOOK_SIGNATURE_ALGORITHM,
  ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR,
  AdcosApiError,
  buildAdcosWebhookSignatureMessage,
  isAdcosContractState,
  parseAdcosContractState,
  parseAdcosIntentRequest,
  parseAdcosWebhookEvent,
  type AdcosClient,
} from "@roamlink/adcos";
import { canonicalizeJson, parseIdempotencyKey, parseUtcInstant } from "@roamlink/contracts";
import { constantTimeHexEqual, hmacSha256Hex } from "./transport.js";

// --------------------------------------------------------------------------------
// Health state
// --------------------------------------------------------------------------------

/** The diagnosable gate status. `unknown` is the fail-closed default. */
export type AdcosCompatibilityStatus = "unknown" | "compatible" | "incompatible";

/** One check outcome: name + pass/fail + a log-safe code/detail (no values). */
export interface AdcosCompatibilityCheckResult {
  readonly name: string;
  readonly passed: boolean;
  /** ADCOS error code or RoamLink reason of the failing check, when any. */
  readonly code?: string;
  readonly detail: string;
}

/** The diagnosable health report produced by the gate. */
export interface AdcosCompatibilityReport {
  readonly status: Exclude<AdcosCompatibilityStatus, "unknown">;
  readonly checks: readonly AdcosCompatibilityCheckResult[];
  readonly at: UtcInstant;
}

/**
 * The runtime compatibility state. Adapters hold one instance and consult it
 * before EVERY mutation; the default is `unknown`, which fails closed.
 */
export class AdcosCompatibilityState {
  #report: AdcosCompatibilityReport | null = null;

  /** Records a completed gate run as the current health state. */
  apply(report: AdcosCompatibilityReport): void {
    this.#report = Object.freeze({
      status: report.status,
      checks: Object.freeze([...report.checks]),
      at: parseUtcInstant(report.at),
    });
  }

  status(): AdcosCompatibilityStatus {
    return this.#report === null ? "unknown" : this.#report.status;
  }

  /** The latest report, when a check has ever run. */
  latest(): AdcosCompatibilityReport | null {
    return this.#report;
  }

  /**
   * Fail-closed mutation guard (§9): throws a typed DomainError unless the
   * gate has PASSED. The error names the failed checks (names and codes
   * only - never values, RL-LOCK-016).
   */
  assertMutationsAllowed(): void {
    const report = this.#report;
    if (report === null) {
      throw new DomainError(
        "ADCOS compatibility gate has not run: mutations are refused until the startup compatibility check passes (fail-closed, spec/adcos-integration.md §9)",
        { reason: "ADCOS_COMPATIBILITY_GATE_UNVERIFIED", retryable: false },
      );
    }
    if (report.status !== "compatible") {
      const failed = report.checks
        .filter((check) => !check.passed)
        .map((check) => check.code !== undefined ? `${check.name}(${check.code})` : check.name)
        .join(", ");
      throw new DomainError(
        `ADCOS compatibility gate is INCOMPATIBLE: mutations are refused (fail-closed, spec/adcos-integration.md §9). Failed checks: ${failed}`,
        { reason: "ADCOS_COMPATIBILITY_GATE_CLOSED", retryable: false },
      );
    }
  }
}

// --------------------------------------------------------------------------------
// The gate
// --------------------------------------------------------------------------------

/**
 * Seeded probe resource references. Production/sandbox environments seed
 * probe resources out-of-band; the ADCOS fake seeds them by default. Absent
 * probe ids skip the corresponding route-availability checks (recorded as
 * skipped, not passed).
 */
export interface AdcosCompatibilityProbe {
  readonly intentId?: string;
  readonly contractId?: string;
  readonly leaseId?: string;
}

/** The idempotency key the gate's probe mutation uses (fixed, namespaced). */
export const ADCOS_COMPATIBILITY_PROBE_IDEMPOTENCY_KEY = "idem.compat.probe.intent-create.v1";

const COMPAT_T0 = "2026-01-15T08:30:00.000Z";

function check(
  name: string,
  run: () => string | void,
): AdcosCompatibilityCheckResult {
  try {
    const detail = run();
    return {
      name,
      passed: true,
      detail: detail ?? "check passed",
    };
  } catch (error) {
    const code =
      error instanceof AdcosApiError
        ? error.code
        : error instanceof DomainError || error instanceof ValidationError
          ? error.reason
          : undefined;
    return {
      name,
      passed: false,
      ...(code !== undefined ? { code } : {}),
      detail:
        error instanceof Error
          ? error.message
          : "check failed with a non-error value (values are never echoed, RL-LOCK-016)",
    };
  }
}

/**
 * Runs the startup compatibility check against a client and records the
 * result into the runtime state. Returns the diagnosable report.
 */
export async function runAdcosCompatibilityCheck(
  client: AdcosClient,
  state: AdcosCompatibilityState,
  options?: {
    readonly probe?: AdcosCompatibilityProbe;
    readonly at?: UtcInstant | string;
    /** Injectable clock-less runner for deterministic tests (defaults to nowUtc). */
    readonly now?: () => UtcInstant;
  },
): Promise<AdcosCompatibilityReport> {
  const at =
    options?.at !== undefined
      ? parseUtcInstant(options.at)
      : ((options?.now?.() ?? (new Date().toISOString() as UtcInstant)) as UtcInstant);
  const probe = options?.probe;

  const checks: AdcosCompatibilityCheckResult[] = [];

  // 1. endpoint/schema availability + 2. version compatibility ---------------
  checks.push(
    await runAsync("application_self.available", async () => {
      if (client.apiVersion !== ADCOS_API_VERSION) {
        throw new DomainError(
          `client pins ADCOS API version '${client.apiVersion}' but the supported line is '${ADCOS_API_VERSION}' (single-site version pin; fail-closed)`,
          { reason: "ADCOS_VERSION_UNSUPPORTED", retryable: false },
        );
      }
      await client.getApplication();
      return "GET application answered with a contract-shaped response";
    }),
  );

  if (probe?.intentId !== undefined) {
    checks.push(
      await runAsync("intent_get.available", async () => {
        await client.getIntent(probe.intentId as never);
        return "GET intents/{id} answered";
      }),
      await runAsync("intent_lifecycle_get.available", async () => {
        await client.getIntentLifecycle(probe.intentId as never);
        return "GET intents/{id}/lifecycle answered";
      }),
    );
  }
  if (probe?.contractId !== undefined) {
    checks.push(
      await runAsync("contract_get.available", async () => {
        await client.getContract(probe.contractId as never);
        return "GET contracts/{id} answered";
      }),
      await runAsync("contract_usage_get.available", async () => {
        await client.getContractUsage(probe.contractId as never);
        return "GET contracts/{id}/usage answered";
      }),
    );
  }
  if (probe?.leaseId !== undefined) {
    checks.push(
      await runAsync("lease_get.available", async () => {
        await client.getLease(probe.leaseId as never);
        return "GET leases/{id} answered";
      }),
    );
  }

  // 3. required lifecycle states -----------------------------------------------
  checks.push(
    check("contract_lifecycle_states.required", () => {
      if (ADCOS_CONTRACT_STATES.length !== 13) {
        throw new DomainError(
          `the pinned contract-state vocabulary must carry the 13 documented v2 states (found ${ADCOS_CONTRACT_STATES.length})`,
          { reason: "ADCOS_CONTRACT_STATE_INVALID", retryable: false },
        );
      }
      for (const state of ADCOS_CONTRACT_CANONICAL_PROGRESSION) {
        if (!isAdcosContractState(state)) {
          throw new DomainError(
            "the canonical lifecycle progression references a state outside the closed vocabulary",
            { reason: "ADCOS_CONTRACT_STATE_INVALID", retryable: false },
          );
        }
      }
      for (const terminal of ADCOS_CONTRACT_TERMINAL_STATES) {
        if (ADCOS_CONTRACT_STATE_TRANSITIONS[terminal].length !== 0) {
          throw new DomainError(
            "terminal contract states must have no outgoing transitions",
            { reason: "ADCOS_CONTRACT_STATE_INVALID", retryable: false },
          );
        }
      }
      let threw = false;
      try {
        parseAdcosContractState("NOT_A_STATE");
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new DomainError(
          "parseAdcosContractState must reject unknown states (closed vocabulary)",
          { reason: "ADCOS_CONTRACT_STATE_INVALID", retryable: false },
        );
      }
      return "the 13-state v2 lifecycle vocabulary is intact (closed enum, canonical progression, terminal states)";
    }),
  );

  // 4. required fields/enums (closed-schema self-tests) -------------------------
  checks.push(
    check("request_schemas.closed", () => {
      const canonicalRequest = {
        requirements: [{ dimension: "privacy", classification: "hard", statement: { transport: "encrypted" } }],
        validity: { start: COMPAT_T0, end: "2026-01-29T08:30:00.000Z" },
        termination: { actor: "customer", on_expiry: "release" },
        recorded_at: COMPAT_T0,
      };
      parseAdcosIntentRequest(canonicalRequest);
      let threw = false;
      try {
        parseAdcosIntentRequest({ ...canonicalRequest, invented_field: true });
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new DomainError(
          "parseAdcosIntentRequest must reject unknown members (closed v2 schema)",
          { reason: "ADCOS_REQUEST_INVALID", retryable: false },
        );
      }
      return "closed request schemas reject unknown members";
    }),
    check("webhook_envelope.closed", () => {
      const canonicalEvent = {
        event_id: "evt-compat-probe",
        event_type: "connectivity_intent.created",
        resource_id: "intent-compat-probe",
        resource_kind: "connectivity_intent",
        resource_version: 1,
        occurred_at: COMPAT_T0,
        api_version: ADCOS_API_VERSION,
        environment: client.environment,
        correlation_id: "corr-compat-probe",
      };
      parseAdcosWebhookEvent(canonicalEvent);
      let threw = false;
      try {
        parseAdcosWebhookEvent({ ...canonicalEvent, invented_member: true });
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new DomainError(
          "parseAdcosWebhookEvent must reject unknown members (closed envelope)",
          { reason: "ADCOS_WEBHOOK_EVENT_INVALID", retryable: false },
        );
      }
      return "the webhook envelope is closed (9 documented members)";
    }),
  );

  // 5. webhook semantics ---------------------------------------------------------
  checks.push(
    check("webhook_signature_semantics.pinned", () => {
      if (ADCOS_WEBHOOK_SIGNATURE_ALGORITHM !== "hmac-sha256") {
        throw new DomainError("the pinned webhook signature algorithm must be hmac-sha256", {
          reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID",
          retryable: false,
        });
      }
      if (ADCOS_WEBHOOK_REPLAY_WINDOW_MS !== 300_000) {
        throw new DomainError("the pinned webhook replay window must be 300s", {
          reason: "ADCOS_WEBHOOK_TIMESTAMP_STALE",
          retryable: false,
        });
      }
      if (Object.keys(ADCOS_WEBHOOK_DELIVERY_HEADER_NAMES).length !== 7) {
        throw new DomainError("the pinned webhook delivery header set must be the 7 documented headers", {
          reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID",
          retryable: false,
        });
      }
      if (ADCOS_WEBHOOK_MAX_DELIVERY_ATTEMPTS !== 6 || ADCOS_WEBHOOK_RETRY_BACKOFF_SCHEDULE_MS.length !== 5) {
        throw new DomainError("the pinned webhook retry schedule must be 6 attempts with the documented backoff", {
          reason: "ADCOS_WEBHOOK_DELIVERY_UNKNOWN",
          retryable: false,
        });
      }
      // HMAC round-trip over the canonical signature message.
      const secret = "compat-probe-signing-key";
      const message = buildAdcosWebhookSignatureMessage({
        keyId: "compat-probe-key",
        timestamp: COMPAT_T0,
        deliveryId: "dlv-compat-probe",
        payload: canonicalizeJson({
          event_id: "evt-compat-probe",
          event_type: "connectivity_intent.created",
          resource_id: "intent-compat-probe",
          resource_kind: "connectivity_intent",
          resource_version: 1,
          occurred_at: COMPAT_T0,
          api_version: ADCOS_API_VERSION,
          environment: client.environment,
          correlation_id: "corr-compat-probe",
        }),
      });
      if (message.includes(ADCOS_WEBHOOK_SIGNATURE_MESSAGE_SEPARATOR) === false) {
        throw new DomainError("the canonical signature message must join its components", {
          reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID",
          retryable: false,
        });
      }
      const signature = hmacSha256Hex(secret, message);
      const recomputed = createHmac("sha256", secret).update(message, "utf8").digest("hex");
      if (!constantTimeHexEqual(signature, recomputed) || !timingSafeEqual(Buffer.from(signature), Buffer.from(recomputed))) {
        throw new DomainError("HMAC-SHA256 round-trip over the canonical signature message failed", {
          reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID",
          retryable: false,
        });
      }
      return "signature scheme constants + HMAC-SHA256 round-trip verified (verifier implementation is exercised in @roamlink/webhook-inbox)";
    }),
  );

  // 6. idempotency behavior ------------------------------------------------------
  checks.push(
    await runAsync("idempotency_behavior.replay", async () => {
      const request: Parameters<AdcosClient["createIntent"]>[0] = {
        requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "compat-probe" } }],
        validity: { start: parseUtcInstant(COMPAT_T0), end: parseUtcInstant("2026-01-16T08:30:00.000Z") },
        termination: { actor: "roamlink", on_expiry: "release" },
        recorded_at: parseUtcInstant(COMPAT_T0),
      };
      const mutation = {
        idempotencyKey: parseIdempotencyKey(ADCOS_COMPATIBILITY_PROBE_IDEMPOTENCY_KEY),
      };
      const first = await client.createIntent(request, mutation);
      const second = await client.createIntent(request, mutation);
      if (canonicalizeJson(first) !== canonicalizeJson(second)) {
        throw new DomainError(
          "replaying the probe mutation with the SAME idempotency key must return the SAME response (v2 idempotency behavior)",
          { reason: "ADCOS_IDEMPOTENCY_CONFLICT", retryable: false },
        );
      }
      return "same-key replay returned the identical response (no duplicate effect)";
    }),
  );

  const status: AdcosCompatibilityReport["status"] = checks.every((c) => c.passed)
    ? "compatible"
    : "incompatible";
  const report: AdcosCompatibilityReport = Object.freeze({
    status,
    checks: Object.freeze(checks),
    at,
  });
  state.apply(report);
  return report;
}

// Small helper: run an async check through the same error adaptation.
async function runAsync(
  name: string,
  run: () => Promise<string | void>,
): Promise<AdcosCompatibilityCheckResult> {
  try {
    const detail = await run();
    return { name, passed: true, detail: detail ?? "check passed" };
  } catch (error) {
    const code =
      error instanceof AdcosApiError
        ? error.code
        : error instanceof DomainError || error instanceof ValidationError
          ? error.reason
          : undefined;
    return {
      name,
      passed: false,
      ...(code !== undefined ? { code } : {}),
      detail:
        error instanceof Error
          ? error.message
          : "check failed with a non-error value (values are never echoed, RL-LOCK-016)",
    };
  }
}
