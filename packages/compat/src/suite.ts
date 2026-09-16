/**
 * The ADCOS compatibility suite (RL-036, spec/adcos-integration.md §9).
 *
 * The executable form of the §9 startup compatibility gate. The supported
 * ADCOS contract version is configured in ONE place - `ADCOS_API_VERSION`
 * from @roamlink/adcos, consistent with the `SUPPORTED_ADCOS_API_VERSIONS`
 * pin in @roamlink/contracts (a suite check proves they agree).
 *
 * The suite COMPOSES the Wave-2 gate (`runAdcosCompatibilityCheck` from
 * @roamlink/integration: endpoint/schema availability, version
 * compatibility, pinned lifecycle vocabulary, closed request schemas, the
 * webhook envelope, pinned signature constants, idempotency replay) and
 * adds the checks only a full suite can make:
 *
 *  - `version_pin.single_site` - the one-place version pin is consistent
 *    across the adcos boundary, the contracts env pin and the suite;
 *  - `lifecycle_state_vocabulary.server` - the SERVER's lifecycle documents
 *    report states inside the pinned 13-state vocabulary;
 *  - `document_required_fields.resource_version` - the SERVER's resource
 *    documents carry a positive-integer `resource_version` (the field
 *    reconciliation's ordering defense relies on);
 *  - `webhook_verifier_semantics.*` - the pinned HMAC verifier accepts a
 *    properly signed delivery and rejects tampered signatures, stale
 *    timestamps and unknown key ids with the closed error codes;
 *  - `mutation_gate.fail_closed` - the runtime gate wiring refuses
 *    mutations unless the suite passed (fail-closed, diagnosable).
 *
 * Incompatible ADCOS versions FAIL CLOSED for mutations: apply the report
 * to an `AdcosCompatibilityState` and every adapter mutation is refused
 * with a diagnosable health state.
 *
 * Test-double discipline (§10): the suite runs against ANY `AdcosClient` -
 * the local fake in tests (which simulates duplicates, reordering, delayed
 * events, dropped events, transient failures and canonical-state changes),
 * the sandbox/production client at startup. No test depends on ADCOS
 * internals.
 */
import { createHmac } from "node:crypto";
import { DomainError, parseUtcInstant, type UtcInstant } from "@roamlink/contracts";
import { SUPPORTED_ADCOS_API_VERSIONS, type ContractVersion } from "@roamlink/contracts";
import {
  ADCOS_API_VERSION,
  ADCOS_CONTRACT_STATES,
  buildAdcosWebhookSignatureMessage,
  isAdcosContractState,
  type AdcosClient,
  type AdcosWebhookEvent,
} from "@roamlink/adcos";
import {
  AdcosCompatibilityState,
  runAdcosCompatibilityCheck,
  type AdcosCompatibilityCheckResult,
  type AdcosCompatibilityReport,
} from "@roamlink/integration";
import {
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
  signWebhookDelivery,
  type WebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import type { AdcosEnvironment } from "@roamlink/adcos";

// --------------------------------------------------------------------------------
// The suite's own contract version (RL-LOCK-017)
// --------------------------------------------------------------------------------

/** Version of the compatibility-suite report contract itself. */
export const ADCOS_COMPATIBILITY_SUITE_VERSION: ContractVersion = "1.0" as ContractVersion;

/** The single site: the supported ADCOS contract version this suite pins. */
export const SUITE_SUPPORTED_ADCOS_VERSION = ADCOS_API_VERSION;

// --------------------------------------------------------------------------------
// Report types
// --------------------------------------------------------------------------------

export interface AdcosCompatibilitySuiteReport {
  readonly status: "compatible" | "incompatible";
  readonly at: UtcInstant;
  readonly suiteVersion: ContractVersion;
  /** The combined check list (Wave-2 gate checks + suite checks). */
  readonly checks: readonly AdcosCompatibilityCheckResult[];
}

/** The diagnosable health report exposed to the health registry (RL-052). */
export function suiteReportAsGateReport(
  report: AdcosCompatibilitySuiteReport,
): AdcosCompatibilityReport {
  return Object.freeze({
    status: report.status,
    checks: report.checks,
    at: report.at,
  });
}

// --------------------------------------------------------------------------------
// Probe inputs
// --------------------------------------------------------------------------------

export interface AdcosCompatibilitySuiteProbe {
  readonly intentId?: string;
  readonly contractId?: string;
  readonly leaseId?: string;
}

/**
 * Webhook-semantics probe: what the suite needs to sign/verify a sample
 * delivery. The secret only ever crosses this call boundary; it never
 * appears in reports (RL-LOCK-016).
 */
export interface WebhookSemanticsProbe {
  readonly environment: AdcosEnvironment;
  /** The signing key registry the verifier will use. */
  readonly keys: WebhookSigningKeyRegistry | Readonly<Record<string, string>>;
  /** A representative verified event envelope to sign. */
  readonly sampleEvent: AdcosWebhookEvent;
  /** The key id + secret used to sign the sample (must resolve in `keys`). */
  readonly signingKeyId: string;
  readonly signingSecret: string;
  /**
   * An OBSERVED delivery (headers + payload) from the server, verified
   * end-to-end through the pinned verifier: a server whose deliveries do
   * not verify fails the suite closed. Optional - omit when no delivery is
   * available at startup.
   */
  readonly sampleDelivery?: {
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: string;
  };
}

export interface RunAdcosCompatibilitySuiteOptions {
  readonly client: AdcosClient;
  readonly probe?: AdcosCompatibilitySuiteProbe;
  readonly webhookSemantics?: WebhookSemanticsProbe;
  /** Explicit evaluation instant (deterministic in tests). */
  readonly at?: UtcInstant | string;
  /**
   * When provided, the suite applies its final report to this runtime state
   * so mutation adapters fail closed on incompatibility (§9).
   */
  readonly state?: AdcosCompatibilityState;
}

// --------------------------------------------------------------------------------
// The suite
// --------------------------------------------------------------------------------

function check(
  name: string,
  run: () => string | void,
): AdcosCompatibilityCheckResult {
  try {
    const detail = run();
    return { name, passed: true, detail: detail ?? "check passed" };
  } catch (error) {
    const code =
      error instanceof DomainError
        ? error.reason
        : error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string"
          ? (error as { code: string }).code
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

async function checkAsync(
  name: string,
  run: () => Promise<string | void>,
): Promise<AdcosCompatibilityCheckResult> {
  try {
    const detail = await run();
    return { name, passed: true, detail: detail ?? "check passed" };
  } catch (error) {
    const code =
      error instanceof DomainError
        ? error.reason
        : error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string"
          ? (error as { code: string }).code
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
 * Runs the full §9 compatibility suite against a client. The Wave-2 gate
 * runs first (its checks form the base list); the suite's own checks are
 * appended; the status is compatible only when EVERY check passed.
 */
export async function runAdcosCompatibilitySuite(
  options: RunAdcosCompatibilitySuiteOptions,
): Promise<AdcosCompatibilitySuiteReport> {
  const at = options.at !== undefined ? parseUtcInstant(options.at) : (new Date().toISOString() as UtcInstant);
  const internalState = new AdcosCompatibilityState();
  const gateReport = await runAdcosCompatibilityCheck(options.client, internalState, {
    ...(options.probe !== undefined ? { probe: options.probe } : {}),
    at,
  });

  const checks: AdcosCompatibilityCheckResult[] = [...gateReport.checks];

  // --- the one-place version pin (§9 "version compatibility") --------------------
  checks.push(
    check("version_pin.single_site", () => {
      if (SUPPORTED_ADCOS_API_VERSIONS.length !== 1) {
        throw new DomainError(
          "the supported ADCOS API version pin must name exactly one line (single-site configuration)",
          { reason: "ADCOS_VERSION_PIN_INVALID", retryable: false },
        );
      }
      if (SUPPORTED_ADCOS_API_VERSIONS[0] !== ADCOS_API_VERSION) {
        throw new DomainError(
          "the adcos boundary pin and the contracts env pin disagree on the supported ADCOS version (single-site violation)",
          { reason: "ADCOS_VERSION_PIN_INVALID", retryable: false },
        );
      }
      if (options.client.apiVersion !== ADCOS_API_VERSION) {
        throw new DomainError(
          "the client pins a different ADCOS API version than the single-site configuration",
          { reason: "ADCOS_VERSION_UNSUPPORTED", retryable: false },
        );
      }
      return `one supported line, pinned identically in the adcos boundary and the contracts env schema`;
    }),
  );

  // --- server-side lifecycle vocabulary (§9 "required lifecycle states") ---------
  if (options.probe?.intentId !== undefined) {
    checks.push(
      await checkAsync("lifecycle_state_vocabulary.server", async () => {
        const document = await options.client.getIntentLifecycle(options.probe?.intentId as never);
        const state = (document as Record<string, unknown>)["state"];
        if (!isAdcosContractState(state)) {
          throw new DomainError(
            `the server's lifecycle document reports a state outside the pinned ${ADCOS_CONTRACT_STATES.length}-state vocabulary (field name only, never the value)`,
            { reason: "ADCOS_CONTRACT_STATE_INVALID", retryable: false },
          );
        }
        return "the server's lifecycle documents speak the pinned state vocabulary";
      }),
    );
  }

  // --- server-side required fields (§9 "required fields/enums") ------------------
  const fieldTargets: { label: string; read: () => Promise<Record<string, unknown>> }[] = [];
  if (options.probe?.intentId !== undefined) {
    fieldTargets.push({
      label: "intent",
      read: () => options.client.getIntent(options.probe?.intentId as never),
    });
  }
  if (options.probe?.contractId !== undefined) {
    fieldTargets.push({
      label: "contract",
      read: () => options.client.getContract(options.probe?.contractId as never),
    });
  }
  if (options.probe?.leaseId !== undefined) {
    fieldTargets.push({
      label: "lease",
      read: () => options.client.getLease(options.probe?.leaseId as never),
    });
  }
  if (fieldTargets.length > 0) {
    checks.push(
      await checkAsync("document_required_fields.resource_version", async () => {
        for (const target of fieldTargets) {
          const document = await target.read();
          const version = document["resource_version"];
          if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
            throw new DomainError(
              `the server's ${target.label} documents must carry a positive-integer resource_version (the reconciliation ordering field)`,
              { reason: "ADCOS_DOCUMENT_FIELDS_MISSING", retryable: false },
            );
          }
        }
        return "resource documents carry the required resource_version field";
      }),
    );
  }

  // --- webhook verifier semantics (§9 "signature/webhook semantics") -------------
  if (options.webhookSemantics !== undefined) {
    const probe = options.webhookSemantics;
    const registry: WebhookSigningKeyRegistry = isKeyRegistry(probe.keys)
      ? probe.keys
      : new StaticWebhookSigningKeyRegistry(probe.keys as Readonly<Record<string, string>>);
    const verifier = new HmacWebhookVerifier({
      environment: probe.environment,
      keys: registry,
    });
    const receivedAt = at;
    const payload = JSON.stringify(sampleEventPlain(probe.sampleEvent));

    const buildDelivery = (input: {
      readonly keyId: string;
      readonly secret: string;
      readonly timestamp: string;
      readonly deliveryId: string;
      readonly signature: string;
    }): { headers: Record<string, string>; payload: string } => ({
      headers: {
        "X-ADCOS-Signature": input.signature,
        "X-ADCOS-Timestamp": input.timestamp,
        "X-ADCOS-Key-Id": input.keyId,
        "X-ADCOS-Event-Id": probe.sampleEvent.event_id,
        "X-ADCOS-Delivery-Id": input.deliveryId,
        "X-ADCOS-Sequence": "1",
        "X-ADCOS-Algorithm": "hmac-sha256",
      },
      payload,
    });

    const signedDelivery = (timestamp: string, deliveryId: string) => {
      const message = buildAdcosWebhookSignatureMessage({
        keyId: probe.signingKeyId,
        timestamp,
        deliveryId,
        payload,
      });
      return buildDelivery({
        keyId: probe.signingKeyId,
        secret: probe.signingSecret,
        timestamp,
        deliveryId,
        signature: signWebhookDelivery(probe.signingSecret, message),
      });
    };

    checks.push(
      await checkAsync("webhook_verifier_semantics.accepts_valid", async () => {
        const delivery = signedDelivery(at, "dlv-suite-valid");
        const verification = await verifier.verify({
          headers: delivery.headers,
          payload: delivery.payload,
          receivedAt,
        });
        if (!verification.ok) {
          throw new DomainError(
            `a properly signed in-window delivery was rejected (${verification.code}) - the pinned signature semantics must accept valid deliveries`,
            { reason: "ADCOS_WEBHOOK_VERIFICATION_REJECTED", retryable: false },
          );
        }
        if (verification.event.event_id !== probe.sampleEvent.event_id) {
          throw new DomainError("the verifier parsed a different event id than the sample envelope carries", {
            reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID",
            retryable: false,
          });
        }
        return "a properly signed, in-window delivery verifies";
      }),
      await checkAsync("webhook_verifier_semantics.rejects_tampered_signature", async () => {
        const delivery = signedDelivery(at, "dlv-suite-tampered");
        const tampered = {
          headers: {
            ...delivery.headers,
            "X-ADCOS-Signature": `00${(delivery.headers["X-ADCOS-Signature"] ?? "").slice(2)}`,
          },
          payload: delivery.payload,
        };
        const verification = await verifier.verify({
          headers: tampered.headers,
          payload: tampered.payload,
          receivedAt,
        });
        if (verification.ok || verification.code !== "webhook-signature-invalid") {
          throw new DomainError(
            "a tampered signature must fail closed with webhook-signature-invalid",
            { reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID", retryable: false },
          );
        }
        return "tampered signatures fail closed with the pinned code";
      }),
      await checkAsync("webhook_verifier_semantics.rejects_stale_timestamp", async () => {
        const staleTimestamp = new Date(
          new Date(at).getTime() - 300_001,
        ).toISOString();
        const delivery = signedDelivery(staleTimestamp, "dlv-suite-stale");
        const verification = await verifier.verify({
          headers: delivery.headers,
          payload: delivery.payload,
          receivedAt,
        });
        if (verification.ok || verification.code !== "webhook-timestamp-stale") {
          throw new DomainError(
            "an out-of-window (stale) delivery must fail closed with webhook-timestamp-stale (replay defense)",
            { reason: "ADCOS_WEBHOOK_TIMESTAMP_STALE", retryable: false },
          );
        }
        return "out-of-window deliveries fail closed (replay defense)";
      }),
      await checkAsync("webhook_verifier_semantics.rejects_unknown_key", async () => {
        const delivery = signedDelivery(at, "dlv-suite-unknown-key");
        const unknownKey = {
          headers: { ...delivery.headers, "X-ADCOS-Key-Id": "whk-unknown-to-verifier" },
          payload: delivery.payload,
        };
        const verification = await verifier.verify({
          headers: unknownKey.headers,
          payload: unknownKey.payload,
          receivedAt,
        });
        if (verification.ok || verification.code !== "authentication-invalid") {
          throw new DomainError(
            "an unknown signing key id must fail closed with authentication-invalid",
            { reason: "ADCOS_AUTHENTICATION_INVALID", retryable: false },
          );
        }
        return "unknown key ids fail closed with the pinned code";
      }),
    );

    // HMAC known-answer: the pinned signing path is the canonical HMAC-SHA256.
    checks.push(
      check("webhook_signature_semantics.hmac_known_answer", () => {
        const message = buildAdcosWebhookSignatureMessage({
          keyId: probe.signingKeyId,
          timestamp: at,
          deliveryId: "dlv-suite-known-answer",
          payload,
        });
        const viaPinnedHelper = signWebhookDelivery(probe.signingSecret, message);
        const viaNodeCrypto = createHmac("sha256", probe.signingSecret).update(message, "utf8").digest("hex");
        if (viaPinnedHelper !== viaNodeCrypto) {
          throw new DomainError(
            "the pinned signing helper disagrees with the raw HMAC-SHA256 known answer",
            { reason: "ADCOS_WEBHOOK_SIGNATURE_INVALID", retryable: false },
          );
        }
        return "HMAC-SHA256 known-answer verified";
      }),
    );

    // A REAL observed delivery from the server must verify end-to-end:
    // this is the server-driven webhook-semantics gate (a server that signs
    // or delivers outside the pinned scheme fails the suite closed).
    if (probe.sampleDelivery !== undefined) {
      checks.push(
        await checkAsync("webhook_delivery_verifies.server", async () => {
          const verification = await verifier.verify({
            headers: probe.sampleDelivery?.headers as Record<string, string>,
            payload: probe.sampleDelivery?.payload as string,
            receivedAt: at,
          });
          if (!verification.ok) {
            throw new DomainError(
              `the server's observed webhook delivery failed pinned verification (${verification.code})`,
              { reason: "ADCOS_WEBHOOK_DELIVERY_UNVERIFIED", retryable: false },
            );
          }
          return "the observed server delivery verifies end-to-end";
        }),
      );
    }
  }

  // --- mutation-gate fail-closed wiring (§9 "fail closed for mutations") ---------
  checks.push(
    check("mutation_gate.fail_closed", () => {
      const state = new AdcosCompatibilityState();
      // An INCOMPATIBLE report must refuse mutations with a diagnosable error.
      state.apply({
        status: "incompatible",
        checks: Object.freeze([]),
        at,
      });
      let refused = false;
      let reason = "";
      try {
        state.assertMutationsAllowed();
      } catch (error) {
        refused = true;
        reason = error instanceof DomainError ? error.reason : "NOT_DOMAIN_ERROR";
      }
      if (!refused) {
        throw new DomainError(
          "an incompatible gate state must refuse mutations (fail-closed violated)",
          { reason: "ADCOS_COMPATIBILITY_GATE_WIRING_INVALID", retryable: false },
        );
      }
      if (reason !== "ADCOS_COMPATIBILITY_GATE_CLOSED") {
        throw new DomainError(
          "the fail-closed refusal must carry the diagnosable ADCOS_COMPATIBILITY_GATE_CLOSED reason",
          { reason: "ADCOS_COMPATIBILITY_GATE_WIRING_INVALID", retryable: false },
        );
      }
      // A COMPATIBLE report must allow them.
      state.apply({ status: "compatible", checks: Object.freeze([]), at });
      state.assertMutationsAllowed();
      // The UNVERIFIED default must refuse them.
      const fresh = new AdcosCompatibilityState();
      let unverifiedRefused = false;
      try {
        fresh.assertMutationsAllowed();
      } catch {
        unverifiedRefused = true;
      }
      if (!unverifiedRefused) {
        throw new DomainError(
          "an unverified gate state must refuse mutations (fail-closed default violated)",
          { reason: "ADCOS_COMPATIBILITY_GATE_WIRING_INVALID", retryable: false },
        );
      }
      return "the mutation gate fails closed on unverified/incompatible and opens on compatible";
    }),
  );

  const status: AdcosCompatibilitySuiteReport["status"] = checks.every((c) => c.passed)
    ? "compatible"
    : "incompatible";
  const report: AdcosCompatibilitySuiteReport = Object.freeze({
    status,
    at,
    suiteVersion: ADCOS_COMPATIBILITY_SUITE_VERSION,
    checks: Object.freeze(checks),
  });
  options.state?.apply(suiteReportAsGateReport(report));
  return report;
}

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------

function isKeyRegistry(value: unknown): value is WebhookSigningKeyRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { secretForKeyId?: unknown }).secretForKeyId === "function"
  );
}

/** The plain (unbranded) envelope form used for the signed sample payload. */
function sampleEventPlain(event: AdcosWebhookEvent): Record<string, unknown> {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    resource_id: event.resource_id,
    resource_kind: event.resource_kind,
    resource_version: event.resource_version,
    occurred_at: event.occurred_at,
    api_version: event.api_version,
    environment: event.environment,
    correlation_id: event.correlation_id,
  };
}
