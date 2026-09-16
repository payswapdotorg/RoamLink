/**
 * The ADCOS intent adapter (RL-031): intent submission + intent reads through
 * the AdcosClient seam.
 *
 * Responsibilities:
 *  - compile an {@link IntentCommandInput} into the deterministic
 *    {@link IntentCommandDraft} (pure mapping, §4);
 *  - submit the draft via `client.createIntent` with the FULL §5 mutation
 *    context (idempotency key + correlation id from the envelope);
 *  - expose retry-safe resubmission (same key, bumped attempt metadata);
 *  - expose intent reads (get/list/lifecycle) with closed error adaptation;
 *  - enforce the compatibility gate BEFORE every mutation (§9 fail-closed);
 *  - map every boundary failure onto the closed RoamLink error taxonomy
 *    (never invent parallel kinds).
 *
 * Retry policy is deliberately the CALLER's (the durable outbox from
 * @roamlink/persistence schedules retries in production); this adapter makes
 * each attempt SAFE: timeouts surface as `unknown-state` (safe re-issue),
 * connection loss as `unavailable`, and duplicate delivery is absorbed by
 * the idempotency key.
 */
import {
  DomainError,
  type UtcInstant,
} from "@roamlink/contracts";
import { RoamLinkError } from "@roamlink/contracts";
import type {
  AdcosClient,
  AdcosIntentDocument,
  AdcosIntentLifecycleDocument,
  AdcosListQuery,
  AdcosPage,
} from "@roamlink/adcos";
import type { Clock, IdGenerator } from "@roamlink/testkit";
import type { AdcosCompatibilityState } from "./compatibility.js";
import { runAdcosCompatibilityCheck, type AdcosCompatibilityProbe, type AdcosCompatibilityReport } from "./compatibility.js";
import {
  compileIntentCommand,
  retryIntentCommand,
  type IntentCommandDraft,
  type IntentCommandInput,
  type IntentCommandLastErrorInput,
} from "./intent-command.js";
import { mapAdcosFailure } from "./error-mapping.js";

/** Adapter dependencies. The clock + id generator are injected (no ambient time/random). */
export interface AdcosIntentAdapterDeps {
  readonly client: AdcosClient;
  readonly clock: Clock;
  /** Generates RoamLink command ids (canonical UUIDs). */
  readonly commandIds: IdGenerator;
  readonly compatibility: AdcosCompatibilityState;
}

/** What a successful intent submission returns. */
export interface IntentSubmission {
  /** The ADCOS intent document (opaque per the v2 contract). */
  readonly document: AdcosIntentDocument;
  /** The §5 envelope actually used (command id, idempotency key, attempt). */
  readonly envelope: IntentCommandDraft["envelope"];
  readonly attempt: number;
}

export interface SubmitIntentOptions {
  /** Caller correlation id; derived deterministically when absent. */
  readonly correlationId?: string;
  /** Caller idempotency key; derived deterministically when absent. */
  readonly idempotencyKey?: string;
}

/**
 * The intent adapter. One instance is scoped to one client/environment and
 * one compatibility state; it is stateless between calls (all state lives in
 * ADCOS and in the caller's persistence).
 */
export class AdcosIntentAdapter {
  readonly client: AdcosClient;
  readonly compatibility: AdcosCompatibilityState;
  readonly clock: Clock;
  readonly commandIds: IdGenerator;

  constructor(deps: AdcosIntentAdapterDeps) {
    this.client = deps.client;
    this.compatibility = deps.compatibility;
    this.clock = deps.clock;
    this.commandIds = deps.commandIds;
  }

  /**
   * Runs the startup compatibility check through this adapter's client and
   * records it in the shared compatibility state (§9).
   */
  async runCompatibilityCheck(
    probe?: AdcosCompatibilityProbe,
    at?: UtcInstant | string,
  ): Promise<AdcosCompatibilityReport> {
    return runAdcosCompatibilityCheck(this.client, this.compatibility, {
      ...(probe !== undefined ? { probe } : {}),
      ...(at !== undefined ? { at } : {}),
      now: () => this.clock.now(),
    });
  }

  /**
   * Compiles the intent command WITHOUT any I/O (deterministic mapping,
   * §4). Exposed so callers can persist/audit the draft before submitting.
   */
  compile(input: IntentCommandInput, options?: SubmitIntentOptions): IntentCommandDraft {
    return compileIntentCommand(input, {
      at: this.clock.now(),
      commandId: this.commandIds.next(),
      ...(options?.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
      ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
  }

  /**
   * Compiles and submits an intent command in one step. Transport-level
   * failures surface as typed RoamLink errors (`unknown-state` after a
   * timeout, `unavailable` after connection loss); the caller re-issues with
   * {@link resubmit} using the SAME draft (same idempotency key).
   */
  async submit(
    input: IntentCommandInput,
    options?: SubmitIntentOptions,
  ): Promise<IntentSubmission> {
    const draft = this.compile(input, options);
    return this.submitDraft(draft);
  }

  /**
   * Submits an already-compiled draft. Safe to call again after timeout,
   * connection loss or duplicate delivery: the draft's idempotency key is
   * stable and the request bytes are deterministic.
   */
  async submitDraft(draft: IntentCommandDraft): Promise<IntentSubmission> {
    this.compatibility.assertMutationsAllowed();
    try {
      const document = await this.client.createIntent(draft.request, {
        idempotencyKey: draft.envelope.idempotencyKey,
        correlationId: draft.envelope.correlationId,
      });
      return Object.freeze({
        document,
        envelope: draft.envelope,
        attempt: draft.envelope.retry.attempt,
      });
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  /**
   * Builds and submits the retry draft for a failed attempt: same command id,
   * same idempotency key, same request bytes; only the retry metadata
   * advances (RL-LOCK-014). The original INPUT must map to the same digest -
   * a changed payload under a reused key fails loudly.
   */
  async resubmit(
    draft: IntentCommandDraft,
    input: IntentCommandInput,
    lastError: IntentCommandLastErrorInput,
  ): Promise<IntentSubmission> {
    const retry = retryIntentCommand(draft, input, lastError);
    return this.submitDraft(retry);
  }

  // --- reads (no compatibility gate: reads stay diagnosable when incompatible) --

  async getIntent(intentId: string): Promise<AdcosIntentDocument> {
    try {
      return await this.client.getIntent(intentId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  async listIntents(query?: AdcosListQuery): Promise<AdcosPage<AdcosIntentDocument>> {
    try {
      return await this.client.listIntents(query);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }

  async getIntentLifecycle(intentId: string): Promise<AdcosIntentLifecycleDocument> {
    try {
      return await this.client.getIntentLifecycle(intentId as never);
    } catch (error) {
      throw mapAdcosFailure(error);
    }
  }
}

/**
 * Extracts the retry bookkeeping a caller needs after a failed attempt: the
 * reason code (RoamLink) and the occurred instant. Values are never included
 * (RL-LOCK-016).
 */
export function retryMetadataFor(error: RoamLinkError, at: UtcInstant): IntentCommandLastErrorInput {
  if (!(error instanceof RoamLinkError)) {
    throw new DomainError("retryMetadataFor expects a RoamLinkError", {
      reason: "INTEGRATION_ADAPTER_INVALID",
    });
  }
  return { reason: error.reason, kind: error.kind, occurredAt: at };
}
