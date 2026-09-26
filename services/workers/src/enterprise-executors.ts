/**
 * The enterprise command executors (PA-026 — the enterprise runtime
 * completion), bound on the worker seam PA-025 composed.
 *
 * THE AUTHORITY LAW (the handoff's hard rule, held here): the enterprise
 * DOMAIN packages (@roamlink/enterprise) own the enrollment/connector state
 * machines. These executors BIND the domain's own pure functions —
 * `applyEnterpriseEnrollmentCommand` (the RL-063 journey transitions),
 * `negotiateConnectorProvisioning` (the RL-044 capability negotiation) and
 * the domain's fail-closed record parsers — over the BOUND STORES (the
 * shared-persistence adapters @roamlink/api-service exports, the same
 * records-port partitions the workspace read serves). The domain's pure
 * functions + the bound store = the executed fact; the command ledger
 * records it (`commandLedgerDeliveryPort` CAS-writes the executed stage +
 * the resource). NOTHING here re-implements or shadows domain logic: an
 * illegal transition, an unknown field or a missing enrollment fact is the
 * DOMAIN's own typed failure, which the delivery port maps to the honest
 * retryable attempt-failure (COMMAND_EXECUTION_FAILED — backoff, budget,
 * never invented success).
 *
 * The command kinds (the domain's vocabulary, keyed executor-table style):
 *  - `enrollment.create`   POST /v1/enterprise/enrollments — the journey's
 *     draft record (the enterprise surface's own route table,
 *     ENTERPRISE_API_ROUTE_TEMPLATES.enrollments);
 *  - `enrollment.submit` / `enrollment.verify` / `enrollment.activate` /
 *     `enrollment.reject` / `enrollment.cancel` — the journey transitions;
 *     the targeted enrollment id rides the STORED ROUTE PATH (the command
 *     plane's own law: "a targeted command's subject id is its stored route
 *     path"), exactly like the read projections resolve targeted commands.
 *
 *  - `connector.provision` — the PA-023 mutation route: the domain's
 *    capability negotiation over the tenant's current enrollment reference,
 *    the provisioning record persisted in the bound store.
 *
 * THE INVENTION FINDING (recorded per the work order): apps/web renders NO
 * enrollment action (the workspace page renders the enrollment journey
 * read-only; the connector enrollment command is the surface's only
 * enterprise mutation), so services/api's MUTATION_ROUTES gains NO
 * enrollment route — the PA-023 parity law governs and a rendered action
 * MUST have a real route, but an UNRENDERED action must not invent one. The
 * enrollment commands reach the command plane through the SAME
 * `ingestCommand` discipline the /v1 routes call (the future enterprise
 * surface's ingestion path — packages/enterprise's own pinned route
 * templates); these executors are the execution half of that contract.
 *
 * IDEMPOTENCE LAW: every executor first reads the STORED COMMAND — an
 * already-executed command returns its RECORDED resource and applies
 * nothing (the first execution's facts stand, mirroring the ledger's own
 * CAS no-op); a re-execution after a failed ledger write finds the same
 * deterministic resource id (the command's own id — one command, one
 * resource) and converges instead of duplicating.
 */
import { ValidationError, parseTenantId } from "@roamlink/contracts";
import type { OutboxRecord, PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import {
  applyEnterpriseEnrollmentCommand,
  negotiateConnectorProvisioning,
  parseEnterpriseEnrollmentRecord,
  type EnterpriseEnrollmentCommand,
  type EnterpriseEnrollmentRecord,
  type OrganizationRegistrar,
} from "@roamlink/enterprise";
import {
  ENTERPRISE_CONNECTOR_CAPABILITIES,
  CONDITIONAL_ENTERPRISE_CONNECTOR_CAPABILITIES,
} from "@roamlink/edge-connector";

import {
  COMMAND_REPOSITORY,
  createPersistenceConnectorProvisioningStore,
  createPersistenceEnrollmentStore,
  type StoredCommand,
} from "@roamlink/api-service";

import type { CommandExecutionOutcome, CommandExecutor } from "./delivery.js";

// --------------------------------------------------------------------------------
// The composition
// --------------------------------------------------------------------------------

export interface EnterpriseCommandExecutorsOptions {
  /**
   * The REAL shared persistence (the same database the command plane
   * durably accepted commands and outbox obligations into — one truth; the
   * enterprise record partitions live in its records port).
   */
  readonly persistence: UnitOfWorkFactory & PersistenceReader;
  /**
   * The organization registrar port — enrollment verification's ONLY tenant
   * source (the tenant NEVER originates in the enterprise domain;
   * RL-LOCK-003/019). REQUIRED, mirroring the domain's own onboarding
   * service constructor law: a composition that wants enrollment execution
   * must bind the auth-boundary provisioning port.
   */
  readonly registrar: OrganizationRegistrar;
  /**
   * The connector negotiation's REQUESTED set (what the enterprise asks
   * for). Default: the full RL-044 closed vocabulary.
   */
  readonly requestedConnectorCapabilities?: readonly unknown[];
  /**
   * The connector negotiation's AVAILABLE set (what this composition's
   * connector infrastructure actually offers). Default: the GUARANTEED
   * DEGRADATION FLOOR (observation + user-guided actions) — the honest
   * composition for a runtime that binds no MDM/enterprise connector
   * infrastructure; the architecture keeps working on that floor
   * (RL-LOCK-011 spirit), and an enterprise mode is never claimed without
   * enterprise infrastructure.
   */
  readonly availableConnectorCapabilities?: readonly string[];
}

/**
 * The enterprise executor table: the domain's transition functions + the
 * bound stores, composable into `commandLedgerDeliveryPort` on the SAME
 * bounded-tick path PA-025 composed (`createBoundedWorkerTick`).
 */
export function createEnterpriseCommandExecutors(
  options: EnterpriseCommandExecutorsOptions,
): Readonly<Record<string, CommandExecutor>> {
  if (options.registrar === null || typeof options.registrar !== "object") {
    throw new ValidationError(
      "the enterprise command executors require an organization registrar port (enrollment verification's only tenant source)",
      { reason: "ENTERPRISE_EXECUTORS_INVALID" },
    );
  }
  const enrollments = createPersistenceEnrollmentStore(options.persistence);
  const provisioning = createPersistenceConnectorProvisioningStore(options.persistence);

  // The negotiation sets (the composition's own facts, from the owning
  // RL-044 closed vocabulary directly — never redefined here).
  const requested =
    options.requestedConnectorCapabilities ?? ENTERPRISE_CONNECTOR_CAPABILITIES;
  const available =
    options.availableConnectorCapabilities ??
    ENTERPRISE_CONNECTOR_CAPABILITIES.filter(
      (capability) => !CONDITIONAL_ENTERPRISE_CONNECTOR_CAPABILITIES.includes(capability),
    );

  return {
    // --- the enrollment journey (the domain's RL-063 state machine) --------
    "enrollment.create": async (_record, obligation, at): Promise<CommandExecutionOutcome | void> => {
      // The first execution's facts stand: an already-executed command
      // returns its recorded resource and applies nothing.
      const stored = await storedCommandOf(options.persistence, obligation.commandId);
      if (stored !== null && stored.executedAt !== null) {
        return stored.resource !== null ? { resource: stored.resource } : undefined;
      }
      const body = requirePayloadObject("enrollment.create", obligation.payload);
      const organizationName = requireNonEmptyString("enrollment.create", body, "organizationName");
      // The creation event IS the resource: one command, one enrollment —
      // the command's own canonical id (a re-execution after a failed ledger
      // write converges on the same record instead of duplicating it).
      const record = parseEnterpriseEnrollmentRecord({
        enrollmentId: obligation.commandId,
        contractVersion: "0.1",
        organizationName,
        tenantId: null,
        requestedBy: obligation.actorId,
        state: "draft",
        createdAt: at,
        updatedAt: at,
        revision: 1,
      });
      if ((await enrollments.get(record.enrollmentId)) === null) {
        await enrollments.save(record);
      }
      return { resource: { type: "enterprise_enrollment", id: record.enrollmentId, version: record.revision } };
    },

    "enrollment.submit": enrollmentTransitionExecutor("submit", enrollments),
    "enrollment.verify": enrollmentTransitionExecutor("verify", enrollments, options.registrar),
    "enrollment.activate": enrollmentTransitionExecutor("activate", enrollments),
    "enrollment.reject": enrollmentTransitionExecutor("reject", enrollments),
    "enrollment.cancel": enrollmentTransitionExecutor("cancel", enrollments),

    // --- the connector provisioning (the domain's RL-044 negotiation) ------
    "connector.provision": async (_record, obligation, at): Promise<CommandExecutionOutcome | void> => {
      const stored = await storedCommandOf(options.persistence, obligation.commandId);
      if (stored !== null && stored.executedAt !== null) {
        return stored.resource !== null ? { resource: stored.resource } : undefined;
      }
      const body = requirePayloadObject("connector.provision", obligation.payload);
      const connectorId = requireNonEmptyString("connector.provision", body, "connectorId");
      // The provisioning references the tenant's CURRENT enrollment (the
      // domain record's required foreign reference). A tenant with no bound
      // enrollment has nothing to provision under yet — the honest retryable
      // refusal (the enrollment may verify on a later tick; never invented).
      const current = await currentEnrollmentOf(enrollments, obligation.tenantId);
      if (current === null) {
        throw new ValidationError(
          "the connector.provision execution found no enrollment bound to this tenant yet (the provisioning record references the tenant's enrollment; verification comes first)",
          { reason: "CONNECTOR_ENROLLMENT_REFERENCE_MISSING" },
        );
      }
      // The domain's own negotiation: the pure function + the bound store.
      // One command, one provisioning (the command's own canonical id).
      const record = negotiateConnectorProvisioning(
        {
          provisioningId: obligation.commandId,
          tenantId: obligation.tenantId,
          enrollmentId: current.enrollmentId,
          connectorId,
          contractVersion: "0.1",
        },
        requested,
        available,
        at,
      );
      if ((await provisioning.get(record.provisioningId, obligation.tenantId)) === null) {
        await provisioning.save(record);
      }
      return {
        resource: { type: "connector_provisioning", id: record.provisioningId, version: record.revision },
      };
    },
  };

  /**
   * One enrollment journey transition executor: the domain's pure transition
   * function over the bound store, the enrollment id resolved from the
   * STORED ROUTE PATH (the command plane's targeted-command law).
   */
  function enrollmentTransitionExecutor(
    command: EnterpriseEnrollmentCommand,
    store: ReturnType<typeof createPersistenceEnrollmentStore>,
    registrar?: OrganizationRegistrar,
  ): CommandExecutor {
    return async (_record: OutboxRecord, obligation, at): Promise<CommandExecutionOutcome | void> => {
      const stored = await storedCommandOf(options.persistence, obligation.commandId);
      if (stored !== null && stored.executedAt !== null) {
        return stored.resource !== null ? { resource: stored.resource } : undefined;
      }
      if (stored === null) {
        throw new ValidationError(
          `the enrollment.${command} obligation names a command that is not in the ledger (failing closed)`,
          { reason: "COMMAND_LEDGER_CORRUPT" },
        );
      }
      const enrollmentId = enrollmentIdOfRoute(stored.route, command);
      const current = await store.get(enrollmentId);
      if (current === null) {
        // Retryable: a same-tick sibling create may not have executed yet
        // (the outbox claims in due order, not dependency order) — the next
        // delivery finds the created journey.
        throw new ValidationError(
          `the enrollment ${command} command's target enrollment does not exist yet (it may be created by a not-yet-executed command)`,
          { reason: "ENTERPRISE_ENROLLMENT_NOT_FOUND" },
        );
      }
      let tenantId = current.tenantId;
      if (command === "verify" && tenantId === null) {
        // The ONLY tenant source: the registrar port (auth-owned identity).
        const provisioned = await registrar?.provisionOrganization({
          organizationName: current.organizationName,
          requestedBy: current.requestedBy,
        });
        if (provisioned === undefined) {
          throw new ValidationError(
            "the enrollment verify execution requires the registrar port (the tenant never originates in the enterprise domain)",
            { reason: "ENTERPRISE_ENROLLMENT_TENANT_UNBOUND" },
          );
        }
        // The domain's own tenant validation (fail-closed on a malformed
        // provisioned tenant; the tenant NEVER originates here).
        tenantId = parseTenantId(provisioned.tenantId);
      }
      const body = requirePayloadObject(`enrollment.${command}`, obligation.payload);
      const transition = applyEnterpriseEnrollmentCommand(current, command, at, {
        tenantId,
        ...(command === "reject"
          ? { rejectionReason: requireNonEmptyString("enrollment.reject", body, "rejectionReason") }
          : {}),
      });
      if (transition.applied) {
        await store.save(transition.record);
      }
      return {
        resource: {
          type: "enterprise_enrollment",
          id: transition.record.enrollmentId,
          version: transition.record.revision,
        },
      };
    };
  }
}

// --------------------------------------------------------------------------------
// The executor-plane helpers (fail closed BEFORE the executed stage)
// --------------------------------------------------------------------------------

/** Reads the stored command (the ledger's own record of the obligation). */
async function storedCommandOf(
  persistence: PersistenceReader,
  commandId: string,
): Promise<StoredCommand | null> {
  const stored = await persistence.records(COMMAND_REPOSITORY).get(commandId);
  return stored === null ? null : (stored.value as unknown as StoredCommand);
}

/** The targeted enrollment id of the enterprise surface's route paths. */
function enrollmentIdOfRoute(route: string, command: EnterpriseEnrollmentCommand): string {
  const match = new RegExp(`^/v1/enterprise/enrollments/([^/]+)/${command}$`).exec(route);
  if (match === null) {
    throw new ValidationError(
      `the enrollment ${command} command's stored route does not carry its target enrollment id (the enterprise surface's route shape is /v1/enterprise/enrollments/\\{enrollmentId\\}/${command})`,
      { reason: "COMMAND_ROUTE_INVALID" },
    );
  }
  return match[1] as string;
}

/** The tenant's CURRENT enrollment (the latest bound record; null if none). */
async function currentEnrollmentOf(
  store: ReturnType<typeof createPersistenceEnrollmentStore>,
  tenantId: string,
): Promise<EnterpriseEnrollmentRecord | null> {
  const bound = (await store.list()).filter((record) => record.tenantId === tenantId);
  let current: EnterpriseEnrollmentRecord | undefined;
  for (const candidate of bound) {
    if (
      current === undefined ||
      candidate.updatedAt > current.updatedAt ||
      (candidate.updatedAt === current.updatedAt && candidate.revision > current.revision) ||
      (candidate.updatedAt === current.updatedAt &&
        candidate.revision === current.revision &&
        candidate.enrollmentId > current.enrollmentId)
    ) {
      current = candidate;
    }
  }
  return current ?? null;
}

function executorInvalid(kind: string, issue: string, path: string): never {
  throw new ValidationError(
    `the ${kind} execution refused the command before the executed stage: ${issue}`,
    { reason: "COMMAND_PAYLOAD_INVALID", details: [{ path, issue }] },
  );
}

function requirePayloadObject(kind: string, payload: unknown): Record<string, unknown> {
  // The API plane stores the command payload as its CANONICAL JSON STRING
  // (the ingest's canonicalizeJson — the same storage shape the read models
  // parse back); the object form is also accepted (defensive dual parse).
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
