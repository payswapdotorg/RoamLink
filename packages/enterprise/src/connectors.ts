/**
 * Connector provisioning + managed-edge enrollment (RL-063, spec/mobile.md
 * "Enterprise edge", spec/architecture.md §8).
 *
 * The enterprise side of the RL-044 edge-connector contract: provisioning an
 * enterprise tenant's edge fleet means (1) registering the CONNECTOR with a
 * negotiated capability set - expressed through @roamlink/edge-connector's
 * CLOSED vocabularies directly (no redefinition, no drift possible), whose
 * guaranteed degradation floor is observation + user-guided actions - and
 * (2) enrolling MANAGED EDGE DEVICES under that provisioning.
 *
 * The architecture still works when only observation and user-guided
 * actions are available: a provisioning record whose connector negotiated
 * ONLY the floor capabilities is fully valid and its operating mode is the
 * honest `user-guided` / `observation-only` value (RL-LOCK-011 spirit).
 * Enterprise integrations may observe and request connectivity but never
 * create a second path/session authority (RL-LOCK-004/005) - these records
 * carry configuration references ONLY, never path/session state.
 */
import {
  ValidationError,
  parseContractVersion,
  parseRevision,
  parseTenantId,
  parseUtcInstant,
  type ContractVersion,
  type Revision,
  type TenantId,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  negotiateConnectorCapabilities,
  parseEnterpriseConnectorCapabilitySet,
  type ConnectorOperatingMode,
  type EnterpriseConnectorCapability,
} from "@roamlink/edge-connector";

import {
  parseConnectorProvisioningId,
  parseManagedEdgeEnrollmentId,
  type ConnectorProvisioningId,
  type ManagedEdgeEnrollmentId,
} from "./ids.js";
import {
  describeEnterpriseContractVersionExpectation,
  isEnterpriseRecordVersionCompatible,
} from "./version.js";

/** The closed connector-provisioning lifecycle vocabulary. */
export const CONNECTOR_PROVISIONING_STATES = [
  "provisioning",
  "provisioned",
  "failed",
  "revoked",
] as const;

export type ConnectorProvisioningState = (typeof CONNECTOR_PROVISIONING_STATES)[number];

export function isConnectorProvisioningState(
  value: unknown,
): value is ConnectorProvisioningState {
  return (
    typeof value === "string" &&
    (CONNECTOR_PROVISIONING_STATES as readonly string[]).includes(value)
  );
}

/** Closed reasons a provisioning attempt failed. */
export const CONNECTOR_PROVISIONING_FAILURE_REASONS = [
  "connector-unavailable",
  "capability-negotiation-empty",
  "configuration-delivery-failed",
] as const;

export type ConnectorProvisioningFailureReason =
  (typeof CONNECTOR_PROVISIONING_FAILURE_REASONS)[number];

const CONNECTOR_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/** Serialized (plain) form of a connector provisioning record. */
export interface ConnectorProvisioningRecord {
  readonly provisioningId: ConnectorProvisioningId;
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  /** The enterprise enrollment this provisioning belongs to. */
  readonly enrollmentId: string;
  /** Bounded, printable connector label (diagnostics; never secrets). */
  readonly connectorId: string;
  /** The negotiated capability set (the RL-044 closed vocabulary). */
  readonly capabilities: readonly EnterpriseConnectorCapability[];
  /** The honest effective operating mode after negotiation (RL-044). */
  readonly operatingMode: ConnectorOperatingMode;
  readonly state: ConnectorProvisioningState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
  readonly failureReason?: ConnectorProvisioningFailureReason;
}

/** Input accepted by {@link parseConnectorProvisioningRecord}. */
export interface ConnectorProvisioningInput {
  readonly provisioningId: string;
  readonly contractVersion?: string;
  readonly tenantId: string;
  readonly enrollmentId: string;
  readonly connectorId: string;
  readonly capabilities: readonly string[];
  readonly operatingMode: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly failureReason?: string;
}

const ALLOWED_FIELDS = new Set([
  "provisioningId",
  "contractVersion",
  "tenantId",
  "enrollmentId",
  "connectorId",
  "capabilities",
  "operatingMode",
  "state",
  "createdAt",
  "updatedAt",
  "revision",
  "failureReason",
]);

function field(label: string, issue: string): never {
  throw new ValidationError(`ConnectorProvisioningRecord rejected: ${label} - ${issue}`, {
    reason: "CONNECTOR_PROVISIONING_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Parses and freezes a connector provisioning record. The capability set is
 * validated through the RL-044 closed-vocabulary parser DIRECTLY (the
 * owning contract - this package never redefines it), and the recorded
 * operating mode must be exactly the mode the stored negotiation result
 * yields (an inconsistent record is a contract violation, fail-closed).
 */
export function parseConnectorProvisioningRecord(value: unknown): ConnectorProvisioningRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      field(key, "unknown field (the provisioning record carries exactly its contract fields; configuration values and credentials travel through the RL-044 delivery contract, never here)");
    }
  }
  let provisioningId: ConnectorProvisioningId;
  try {
    provisioningId = parseConnectorProvisioningId(input["provisioningId"]);
  } catch {
    field("provisioningId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"] ?? "0.1");
  } catch {
    field("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEnterpriseRecordVersionCompatible(contractVersion)) {
    field("contractVersion", describeEnterpriseContractVersionExpectation());
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    field("tenantId", "must be a RoamLink tenant id");
  }
  const enrollmentId = input["enrollmentId"];
  if (typeof enrollmentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(enrollmentId)) {
    field("enrollmentId", "must reference the owning enterprise enrollment (canonical UUID)");
  }
  const connectorId = input["connectorId"];
  if (typeof connectorId !== "string" || !CONNECTOR_LABEL_PATTERN.test(connectorId)) {
    field("connectorId", "must be a bounded, printable connector label (never a secret)");
  }
  let capabilities: readonly EnterpriseConnectorCapability[];
  try {
    capabilities = parseEnterpriseConnectorCapabilitySet(
      (Array.isArray(input["capabilities"]) ? input["capabilities"] : null) ?? [],
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      field("capabilities", error.message);
    }
    throw error;
  }
  const operatingMode = input["operatingMode"];
  if (
    typeof operatingMode !== "string" ||
    !(["enterprise", "user-guided", "observation-only"] as readonly string[]).includes(
      operatingMode,
    )
  ) {
    field("operatingMode", "must be a member of the RL-044 operating-mode vocabulary");
  }
  // Consistency: the recorded mode must equal what the stored capabilities
  // actually negotiate (fail-closed on doctored records).
  const renegotiated = negotiateConnectorCapabilities(capabilities, capabilities);
  if (renegotiated.operatingMode !== operatingMode) {
    field(
      "operatingMode",
      "must match the mode the stored capability set actually negotiates (a doctored record fails closed)",
    );
  }
  const state = input["state"];
  if (!isConnectorProvisioningState(state)) {
    field("state", "must be a member of the closed provisioning lifecycle vocabulary");
  }
  let createdAt: UtcInstant;
  try {
    createdAt = parseUtcInstant(input["createdAt"]);
  } catch {
    field("createdAt", "must be a UTC instant with an explicit zone designator");
  }
  let updatedAt: UtcInstant;
  try {
    updatedAt = parseUtcInstant(input["updatedAt"]);
  } catch {
    field("updatedAt", "must be a UTC instant with an explicit zone designator");
  }
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    field("revision", "must be a positive integer (optimistic-concurrency revision)");
  }
  let failureReason: ConnectorProvisioningFailureReason | undefined;
  if (input["failureReason"] !== undefined) {
    if (
      typeof input["failureReason"] !== "string" ||
      !(CONNECTOR_PROVISIONING_FAILURE_REASONS as readonly string[]).includes(
        input["failureReason"],
      )
    ) {
      field("failureReason", "must be a member of the closed provisioning-failure vocabulary");
    }
    failureReason = input["failureReason"] as ConnectorProvisioningFailureReason;
  }
  if (state === "failed" && failureReason === undefined) {
    field("failureReason", "a failed provisioning must carry its closed-vocabulary reason");
  }
  if (state !== "failed" && failureReason !== undefined) {
    field("failureReason", "only a failed provisioning carries a failure reason");
  }

  return Object.freeze({
    provisioningId,
    contractVersion,
    tenantId,
    enrollmentId: enrollmentId as string,
    connectorId: connectorId as string,
    capabilities,
    operatingMode: operatingMode as ConnectorOperatingMode,
    state,
    createdAt,
    updatedAt,
    revision,
    ...(failureReason !== undefined ? { failureReason } : {}),
  });
}

/**
 * Runs the RL-044 capability negotiation for a tenant's connector request
 * and records the provisioning result. The requested set is arbitrary input
 * (unknown entries degrade, never crash - RL-044 semantics); the AVAILABLE
 * set is validated against the closed vocabulary. The guaranteed floor
 * (observation + user-guided actions) keeps the architecture working.
 */
export function negotiateConnectorProvisioning(
  input: {
    readonly provisioningId: string;
    readonly tenantId: string;
    readonly enrollmentId: string;
    readonly connectorId: string;
    readonly contractVersion?: string;
  },
  requested: readonly unknown[],
  available: readonly string[],
  at: UtcInstant | string,
): ConnectorProvisioningRecord {
  const instant = parseUtcInstant(at);
  let availableCapabilities: readonly EnterpriseConnectorCapability[];
  try {
    availableCapabilities = parseEnterpriseConnectorCapabilitySet(available);
  } catch (error) {
    if (error instanceof ValidationError) {
      field("available", error.message);
    }
    throw error;
  }
  const negotiation = negotiateConnectorCapabilities(requested, availableCapabilities);
  const state: ConnectorProvisioningState =
    negotiation.granted.length === 0 ? "failed" : "provisioned";
  return parseConnectorProvisioningRecord({
    provisioningId: input.provisioningId,
    contractVersion: input.contractVersion ?? "0.1",
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    connectorId: input.connectorId,
    capabilities: negotiation.granted,
    operatingMode: negotiation.operatingMode,
    state,
    createdAt: instant,
    updatedAt: instant,
    revision: 1,
    ...(state === "failed"
      ? { failureReason: "capability-negotiation-empty" as const }
      : {}),
  });
}

/** Pure lifecycle transition on a provisioning record. */
export function applyConnectorProvisioningTransition(
  record: ConnectorProvisioningRecord,
  next: ConnectorProvisioningState,
  at: UtcInstant | string,
  options?: { readonly failureReason?: string },
): ConnectorProvisioningRecord {
  const instant = parseUtcInstant(at);
  if (record.state === next) return record;
  const legal: Readonly<
    Record<ConnectorProvisioningState, readonly ConnectorProvisioningState[]>
  > = {
    provisioning: Object.freeze(["provisioned", "failed", "revoked"] as const),
    provisioned: Object.freeze(["revoked"] as const),
    failed: Object.freeze([] as const),
    revoked: Object.freeze([] as const),
  };
  if (!legal[record.state].includes(next)) {
    throw new ValidationError(
      `the connector provisioning cannot move from '${record.state}' to '${next}' (closed lifecycle)`,
      {
        reason: "CONNECTOR_PROVISIONING_TRANSITION_INVALID",
        details: [{ path: "state", issue: `${record.state} -> ${next} is not legal` }],
      },
    );
  }
  return parseConnectorProvisioningRecord({
    ...record,
    state: next,
    updatedAt: instant,
    revision: record.revision + 1,
    ...(next === "failed" ? { failureReason: options?.failureReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Managed-edge device enrollment
// ---------------------------------------------------------------------------

/** The closed managed-edge enrollment lifecycle vocabulary. */
export const MANAGED_EDGE_ENROLLMENT_STATES = ["enrolled", "retired"] as const;

export type ManagedEdgeEnrollmentState = (typeof MANAGED_EDGE_ENROLLMENT_STATES)[number];

export function isManagedEdgeEnrollmentState(
  value: unknown,
): value is ManagedEdgeEnrollmentState {
  return (
    typeof value === "string" &&
    (MANAGED_EDGE_ENROLLMENT_STATES as readonly string[]).includes(value)
  );
}

/**
 * A managed edge device enrolled under a connector provisioning: the landing
 * record for the mobile/edge shell's signed capability-snapshot publication
 * (RL-062). Carries the publication's digest + sequence for traceability -
 * NEVER the snapshot itself (that stays at the edge) and never any
 * credential (edge credentials are short-lived RL-044 grants, issued
 * separately on the device).
 */
export interface ManagedEdgeEnrollmentRecord {
  readonly managedEnrollmentId: ManagedEdgeEnrollmentId;
  readonly contractVersion: ContractVersion;
  readonly tenantId: TenantId;
  readonly provisioningId: string;
  /** The edge device reference (opaque; the device registry owns identity). */
  readonly deviceRef: string;
  readonly connectorId: string;
  /** Digest of the published capability snapshot (traceability). */
  readonly capabilitySnapshotDigest: string;
  /** The publication's monotonic sequence at enrollment. */
  readonly capabilitySnapshotSequence: Revision;
  readonly state: ManagedEdgeEnrollmentState;
  readonly enrolledAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly revision: Revision;
  readonly retiredAt?: UtcInstant;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DEVICE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

/** Input accepted by {@link parseManagedEdgeEnrollmentRecord}. */
export interface ManagedEdgeEnrollmentInput {
  readonly managedEnrollmentId: string;
  readonly contractVersion?: string;
  readonly tenantId: string;
  readonly provisioningId: string;
  readonly deviceRef: string;
  readonly connectorId: string;
  readonly capabilitySnapshotDigest: string;
  readonly capabilitySnapshotSequence: number;
  readonly state: string;
  readonly enrolledAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly retiredAt?: string;
}

const ALLOWED_MANAGED_FIELDS = new Set([
  "managedEnrollmentId",
  "contractVersion",
  "tenantId",
  "provisioningId",
  "deviceRef",
  "connectorId",
  "capabilitySnapshotDigest",
  "capabilitySnapshotSequence",
  "state",
  "enrolledAt",
  "updatedAt",
  "revision",
  "retiredAt",
]);

function managedField(label: string, issue: string): never {
  throw new ValidationError(`ManagedEdgeEnrollmentRecord rejected: ${label} - ${issue}`, {
    reason: "MANAGED_EDGE_ENROLLMENT_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses and freezes a managed-edge device enrollment (fail-closed). */
export function parseManagedEdgeEnrollmentRecord(value: unknown): ManagedEdgeEnrollmentRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    managedField("$", "input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_MANAGED_FIELDS.has(key)) {
      managedField(key, "unknown field (the managed enrollment carries references + the publication digest; credentials are RL-044 grants, never fields here)");
    }
  }
  let managedEnrollmentId: ManagedEdgeEnrollmentId;
  try {
    managedEnrollmentId = parseManagedEdgeEnrollmentId(input["managedEnrollmentId"]);
  } catch {
    managedField("managedEnrollmentId", "must be a canonical lowercase UUID");
  }
  let contractVersion: ContractVersion;
  try {
    contractVersion = parseContractVersion(input["contractVersion"] ?? "0.1");
  } catch {
    managedField("contractVersion", "must be a MAJOR.MINOR contract version");
  }
  if (!isEnterpriseRecordVersionCompatible(contractVersion)) {
    managedField("contractVersion", describeEnterpriseContractVersionExpectation());
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(input["tenantId"]);
  } catch {
    managedField("tenantId", "must be a RoamLink tenant id");
  }
  const provisioningId = input["provisioningId"];
  if (
    typeof provisioningId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(provisioningId)
  ) {
    managedField("provisioningId", "must reference the owning connector provisioning (canonical UUID)");
  }
  const deviceRef = input["deviceRef"];
  if (typeof deviceRef !== "string" || !DEVICE_REF_PATTERN.test(deviceRef)) {
    managedField("deviceRef", "must be a non-empty safe device reference (opaque; identity belongs to the device registry)");
  }
  const connectorId = input["connectorId"];
  if (typeof connectorId !== "string" || !CONNECTOR_LABEL_PATTERN.test(connectorId)) {
    managedField("connectorId", "must be a bounded, printable connector label");
  }
  const capabilitySnapshotDigest = input["capabilitySnapshotDigest"];
  if (
    typeof capabilitySnapshotDigest !== "string" ||
    !DIGEST_PATTERN.test(capabilitySnapshotDigest)
  ) {
    managedField("capabilitySnapshotDigest", "must be a SHA-256 hex digest of the published edge capability snapshot");
  }
  let capabilitySnapshotSequence: Revision;
  try {
    capabilitySnapshotSequence = parseRevision(input["capabilitySnapshotSequence"]);
  } catch {
    managedField("capabilitySnapshotSequence", "must be a positive integer (the publication sequence)");
  }
  const state = input["state"];
  if (!isManagedEdgeEnrollmentState(state)) {
    managedField("state", "must be a member of the closed managed-edge enrollment vocabulary");
  }
  let enrolledAt: UtcInstant;
  try {
    enrolledAt = parseUtcInstant(input["enrolledAt"]);
  } catch {
    managedField("enrolledAt", "must be a UTC instant with an explicit zone designator");
  }
  let updatedAt: UtcInstant;
  try {
    updatedAt = parseUtcInstant(input["updatedAt"]);
  } catch {
    managedField("updatedAt", "must be a UTC instant with an explicit zone designator");
  }
  let revision: Revision;
  try {
    revision = parseRevision(input["revision"]);
  } catch {
    managedField("revision", "must be a positive integer (optimistic-concurrency revision)");
  }
  let retiredAt: UtcInstant | undefined;
  if (input["retiredAt"] !== undefined) {
    try {
      retiredAt = parseUtcInstant(input["retiredAt"]);
    } catch {
      managedField("retiredAt", "must be a UTC instant with an explicit zone designator");
    }
  }
  if (state === "retired" && retiredAt === undefined) {
    managedField("retiredAt", "a retired managed enrollment carries its retirement instant");
  }
  if (state !== "retired" && retiredAt !== undefined) {
    managedField("retiredAt", "only a retired managed enrollment carries a retirement instant");
  }
  return Object.freeze({
    managedEnrollmentId,
    contractVersion,
    tenantId,
    provisioningId: provisioningId as string,
    deviceRef: deviceRef as string,
    connectorId: connectorId as string,
    capabilitySnapshotDigest,
    capabilitySnapshotSequence,
    state: state as ManagedEdgeEnrollmentState,
    enrolledAt,
    updatedAt,
    revision,
    ...(retiredAt !== undefined ? { retiredAt } : {}),
  });
}
