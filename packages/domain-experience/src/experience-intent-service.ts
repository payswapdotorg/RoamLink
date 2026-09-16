/**
 * Experience intent service (RL-011): envelope-gated, idempotent,
 * CAS-aware use cases for intent creation, revision and lifecycle.
 *
 * Optimistic concurrency uses the Wave-0 envelope's `intentVersion` field:
 * mutating commands MUST carry the intent header revision they observed;
 * a mismatch is a typed ConflictError (never a silent overwrite). Replay of
 * the same envelope returns the recorded outcome (RL-LOCK-014).
 *
 * RL-LOCK-007: no ADCOS type appears here and nothing compiles intents to
 * ConnectivityIntent - that is RL-012 (Wave 2) and lives outside this
 * package.
 */
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CanonicalJsonValue,
  type CommandEnvelope,
  type ExperienceIntentId,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";

import { admitCommand, commitCommand, type IdempotencyLedger } from "./idempotency.js";
import { ExperienceIntent, ExperienceIntentVersion } from "./intent/experience-intent.js";
import type {
  DeviceRepository,
  ExperienceAccessPolicy,
  ExperienceIntentRepository,
  ExperienceIntentVersionRepository,
} from "./ports.js";

export interface ExperienceIntentServiceDeps {
  readonly intents: ExperienceIntentRepository;
  readonly versions: ExperienceIntentVersionRepository;
  readonly policy: ExperienceAccessPolicy;
  readonly ledger: IdempotencyLedger;
  readonly now: () => UtcInstant;
  /** Supplies fresh intent + version ids. */
  readonly generateIntentVersionId: () => string;
  /**
   * Optional device port: when present, a deviceId on a new intent is
   * verified to exist in the intent's tenant and to not be retired.
   */
  readonly devices?: DeviceRepository;
}

function commandInvalid(issue: string): never {
  throw new ValidationError(`intent command rejected: ${issue}`, {
    reason: "INTENT_COMMAND_INVALID",
    details: [{ path: "envelope", issue }],
  });
}

/** ExperienceIntent use cases (all envelope-gated, idempotent, CAS-aware). */
export class ExperienceIntentService {
  private readonly deps: ExperienceIntentServiceDeps;

  constructor(deps: ExperienceIntentServiceDeps) {
    this.deps = deps;
  }

  /** Creates an intent in `draft` with its first immutable version. */
  async createIntent(
    envelope: CommandEnvelope,
    input: {
      readonly intentId: string;
      readonly ownerUserId: string;
      readonly deviceId?: string;
      readonly payload: unknown;
      readonly rationale?: string;
    },
  ): Promise<{ readonly intentId: string; readonly status: string; readonly versionNumber: number }> {
    type Outcome = { readonly intentId: string; readonly status: string; readonly versionNumber: number };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    await this.deps.policy.authorize(envelope.actorId, envelope.tenantId, "intent:write", this.deps.now());

    if (input.deviceId !== undefined && this.deps.devices !== undefined) {
      const device = await this.deps.devices.findById(envelope.tenantId, input.deviceId as never);
      if (device === undefined) {
        throw new NotFoundError("the intent's target device was not found in the intent tenant", {
          reason: "INTENT_DEVICE_NOT_FOUND",
        });
      }
      if (device.status === "retired") {
        throw new ConflictError("a retired device cannot be the target of a new intent", {
          reason: "INTENT_DEVICE_RETIRED",
        });
      }
    }

    const at = this.deps.now();
    const intentVersionId = this.deps.generateIntentVersionId();
    const version = new ExperienceIntentVersion({
      tenantId: envelope.tenantId,
      intentVersionId,
      intentId: input.intentId,
      versionNumber: 1,
      payload: input.payload,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      createdAt: at,
    });
    const intent = new ExperienceIntent({
      intentId: input.intentId,
      ownerUserId: input.ownerUserId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      status: "draft",
      currentVersionId: version.intentVersionId,
      currentVersionNumber: 1,
      createdAt: at,
      updatedAt: at,
      revision: 1,
    });
    if (intent.tenantId !== envelope.tenantId) {
      commandInvalid(
        "the envelope tenant must match the owner's personal tenant (intents are created in the owner's namespace)",
      );
    }

    await this.deps.intents.save(intent.toRecord());
    await this.deps.versions.save(version.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      intentId: intent.intentId,
      status: intent.status,
      versionNumber: intent.currentVersionNumber,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** Appends the next immutable version (draft/active only; CAS via envelope.intentVersion). */
  async reviseIntent(
    envelope: CommandEnvelope,
    input: {
      readonly intentId: string;
      readonly payload: unknown;
      readonly rationale?: string;
    },
  ): Promise<{ readonly intentId: string; readonly versionNumber: number }> {
    type Outcome = { readonly intentId: string; readonly versionNumber: number };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const intent = await this.findIntent(envelope.tenantId, input.intentId);
    this.expectRevision(envelope, intent.revision);
    await this.deps.policy.authorize(envelope.actorId, envelope.tenantId, "intent:write", this.deps.now());

    const appended = intent.appendVersion({
      intentVersionId: this.deps.generateIntentVersionId(),
      payload: input.payload,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      at: this.deps.now(),
    });
    await this.deps.versions.save(appended.version.toRecord());
    await this.deps.intents.save(appended.intent.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      intentId: appended.intent.intentId,
      versionNumber: appended.intent.currentVersionNumber,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  /** activate | cancel | archive | supersede (CAS via envelope.intentVersion). */
  async transitionIntent(
    envelope: CommandEnvelope,
    input: {
      readonly intentId: string;
      readonly transition: "activate" | "cancel" | "archive" | "supersede";
      readonly supersededBy?: string;
    },
  ): Promise<{ readonly intentId: string; readonly status: string }> {
    type Outcome = { readonly intentId: string; readonly status: string };
    const admission = await admitCommand(this.deps.ledger, envelope);
    if (admission.status === "replay") {
      return admission.outcome as unknown as Outcome;
    }

    const intent = await this.findIntent(envelope.tenantId, input.intentId);
    this.expectRevision(envelope, intent.revision);
    await this.deps.policy.authorize(envelope.actorId, envelope.tenantId, "intent:write", this.deps.now());

    const at = this.deps.now();
    const next =
      input.transition === "activate"
        ? intent.activate(at)
        : input.transition === "cancel"
          ? intent.cancel(at)
          : input.transition === "archive"
            ? intent.archive(at)
            : intent.supersede(input.supersededBy as string, at);
    await this.deps.intents.save(next.toRecord());

    const outcome: CanonicalJsonValue = Object.freeze({
      intentId: next.intentId,
      status: next.status,
    });
    await commitCommand(this.deps.ledger, envelope, outcome, this.deps.now());
    return outcome as unknown as Outcome;
  }

  // --- reads (tenant-scoped; the API layer resolves the actor) ---------------

  async getIntent(tenantId: TenantId, intentId: string) {
    return this.findIntent(tenantId, intentId);
  }

  async listVersions(tenantId: TenantId, intentId: string) {
    return this.deps.versions.listForIntent(tenantId, intentId as ExperienceIntentId);
  }

  async listIntentsByOwner(tenantId: TenantId, ownerUserId: string) {
    return this.deps.intents.listByOwner(tenantId, ownerUserId as never);
  }

  // --- helpers -----------------------------------------------------------------

  private async findIntent(tenantId: TenantId, intentId: string): Promise<ExperienceIntent> {
    const record = await this.deps.intents.findById(tenantId, intentId as ExperienceIntentId);
    if (record === undefined) {
      throw new NotFoundError("experience intent not found in the requested tenant", {
        reason: "INTENT_NOT_FOUND",
      });
    }
    return ExperienceIntent.fromRecord(record);
  }

  /** The envelope's intentVersion is the observed CAS token (Wave-0 §5). */
  private expectRevision(envelope: CommandEnvelope, current: number): void {
    if (envelope.intentVersion !== current) {
      throw new ConflictError(
        "intent optimistic-concurrency conflict: the envelope's intentVersion does not match the stored intent revision (the intent changed concurrently); re-read and retry - never overwrite silently",
        { reason: "REVISION_CONFLICT" },
      );
    }
  }
}
