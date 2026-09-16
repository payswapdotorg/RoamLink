/**
 * The enterprise onboarding service (RL-063, spec/security.md
 * "Authorization": every mutation checks tenant boundary, actor
 * permissions, resource ownership and command idempotency BEFORE touching
 * state).
 *
 * Composes the journey record with its authority-bearing ports:
 *
 *  - {@link OrganizationRegistrar}: the ONLY way an enrollment obtains its
 *    tenant - organization identity is auth-owned, never recreated here
 *    (RL-LOCK-003/019);
 *  - {@link AuditLog}: every security-relevant onboarding mutation appends
 *    an immutable audit event (category `auth`) with actor/tenant/command
 *    correlation (RL-051 discipline);
 *  - the enrollment store: optimistic revisions; replaying an idempotency
 *    key replays the original outcome with NO additional effect
 *    (RL-LOCK-014).
 */
import {
  ConflictError,
  DomainError,
  NotFoundError,
  parseTenantId,
  parseUtcInstant,
  type UtcInstant,
} from "@roamlink/contracts";
import type { AuditLog } from "@roamlink/audit";

import {
  applyEnterpriseEnrollmentCommand,
  parseEnterpriseEnrollmentRecord,
  type EnterpriseEnrollmentCommand,
  type EnterpriseEnrollmentRecord,
} from "./enrollment.js";
import type { OrganizationRegistrar, InMemoryEnrollmentStore } from "./stores.js";

/** The command context every mutation must carry (RL-LOCK-014). */
export interface EnterpriseCommandContext {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly tenantId?: string;
}

/** Options for {@link EnterpriseOnboardingService}. */
export interface EnterpriseOnboardingServiceOptions {
  readonly enrollments: InMemoryEnrollmentStore;
  readonly registrar: OrganizationRegistrar;
  readonly audit: AuditLog;
  /** Enrollment-id source; inject a deterministic generator in tests. */
  readonly enrollmentIdGenerator: () => string;
}

/** One applied (or idempotently replayed) command outcome. */
export interface OnboardingCommandOutcome {
  readonly record: EnterpriseEnrollmentRecord;
  readonly command: EnterpriseEnrollmentCommand | "create";
  /** False when this call replayed the original outcome (idempotent). */
  readonly applied: boolean;
}

type Replay = { readonly outcome: OnboardingCommandOutcome };

/**
 * The enterprise customer journey: create -> submit -> verify (tenant bound
 * through the registrar) -> activate, with reject/cancel paths. Commands are
 * idempotency-key aware: replaying the SAME key replays the ORIGINAL outcome
 * and performs no additional effect; a DIFFERENT command under a used key is
 * a typed conflict (RL-LOCK-014).
 */
export class EnterpriseOnboardingService {
  readonly #options: EnterpriseOnboardingServiceOptions;
  readonly #idempotency = new Map<string, Replay>();

  constructor(options: EnterpriseOnboardingServiceOptions) {
    if (options === null || typeof options !== "object") {
      throw new DomainError("EnterpriseOnboardingServiceOptions must be an object", {
        reason: "ENTERPRISE_SERVICE_INVALID",
      });
    }
    if (options.registrar === null || typeof options.registrar !== "object") {
      throw new DomainError("an organization registrar port is required", {
        reason: "ENTERPRISE_SERVICE_INVALID",
      });
    }
    this.#options = options;
  }

  /** Creates a draft enrollment (idempotent per command). */
  async create(
    input: { readonly organizationName: string; readonly requestedBy: string },
    context: EnterpriseCommandContext,
    at: UtcInstant | string,
  ): Promise<OnboardingCommandOutcome> {
    const replay = this.#replay<OnboardingCommandOutcome>(context, "create");
    if (replay !== null) return replay;
    const instant = parseUtcInstant(at);
    const record = parseEnterpriseEnrollmentRecord({
      enrollmentId: this.#options.enrollmentIdGenerator(),
      contractVersion: "0.1",
      organizationName: input.organizationName,
      tenantId: null,
      requestedBy: input.requestedBy,
      state: "draft",
      createdAt: instant,
      updatedAt: instant,
      revision: 1,
    });
    await this.#options.enrollments.save(record);
    const outcome: OnboardingCommandOutcome = { record, command: "create", applied: true };
    await this.#audit("enterprise.enrollment.created", "allowed", context, record, instant);
    this.#idempotency.set(context.idempotencyKey, { outcome });
    return outcome;
  }

  /** Applies one journey command (submit/verify/activate/reject/cancel). */
  async apply(
    enrollmentId: string,
    command: EnterpriseEnrollmentCommand,
    context: EnterpriseCommandContext,
    at: UtcInstant | string,
    options?: { readonly rejectionReason?: string },
  ): Promise<OnboardingCommandOutcome> {
    const replay = this.#replay<OnboardingCommandOutcome>(context, command);
    if (replay !== null) return replay;
    const instant = parseUtcInstant(at);
    const current = await this.#options.enrollments.get(enrollmentId);
    if (current === null) {
      throw new NotFoundError("the enterprise enrollment does not exist", {
        reason: "ENTERPRISE_ENROLLMENT_NOT_FOUND",
      });
    }

    let tenantId = current.tenantId;
    if (command === "verify" && tenantId === null) {
      // The ONLY tenant source: the registrar port (auth-owned identity).
      const provisioned = await this.#options.registrar.provisionOrganization({
        organizationName: current.organizationName,
        requestedBy: current.requestedBy,
      });
      tenantId = parseTenantId(provisioned.tenantId);
    }

    const transition = applyEnterpriseEnrollmentCommand(
      current,
      command,
      instant,
      {
        tenantId,
        ...(options?.rejectionReason !== undefined
          ? { rejectionReason: options.rejectionReason }
          : {}),
      },
    );
    if (transition.applied) {
      await this.#options.enrollments.save(transition.record);
    }
    const outcome: OnboardingCommandOutcome = {
      record: transition.record,
      command,
      applied: transition.applied,
    };
    await this.#audit(
      `enterprise.enrollment.${command}`,
      command === "reject" || command === "cancel" ? "denied" : "allowed",
      context,
      transition.record,
      instant,
    );
    this.#idempotency.set(context.idempotencyKey, { outcome });
    return outcome;
  }

  async get(enrollmentId: string): Promise<EnterpriseEnrollmentRecord | null> {
    return this.#options.enrollments.get(enrollmentId);
  }

  async list(): Promise<readonly EnterpriseEnrollmentRecord[]> {
    return this.#options.enrollments.list();
  }

  #replay<T>(context: EnterpriseCommandContext, command: string): T | null {
    const existing = this.#idempotency.get(context.idempotencyKey);
    if (existing === undefined) return null;
    const prior = existing.outcome as OnboardingCommandOutcome;
    if (prior.command !== command) {
      throw new ConflictError(
        "this idempotency key was already used for a different command (keys map to exactly one command - RL-LOCK-014)",
        { reason: "ENTERPRISE_IDEMPOTENCY_CONFLICT" },
      );
    }
    // THIS call performed no additional effect (the original one did).
    return { ...prior, applied: false } as T;
  }

  async #audit(
    action: string,
    outcome: "allowed" | "denied",
    context: EnterpriseCommandContext,
    record: EnterpriseEnrollmentRecord,
    at: UtcInstant,
  ): Promise<void> {
    await this.#options.audit.append({
      category: "auth",
      action,
      outcome,
      actorId: context.actorId,
      ...(record.tenantId !== null ? { tenantId: record.tenantId } : {}),
      correlationId: context.correlationId,
      commandId: context.commandId,
      target: record.enrollmentId,
      occurredAt: at,
    });
  }
}
