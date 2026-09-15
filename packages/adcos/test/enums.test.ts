import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import {
  ADCOS_CONTRACT_STATES,
  ADCOS_ENVIRONMENTS,
  ADCOS_ERROR_CODES,
  ADCOS_EXECUTION_STATUSES,
  ADCOS_OPERATIONS,
  ADCOS_WEBHOOK_EVENT_TYPES,
  ADCOS_WEBHOOK_RESOURCE_KINDS,
  isAdcosContractState,
  isAdcosEnvironment,
  isAdcosErrorCode,
  isAdcosExecutionStatus,
  isAdcosOperation,
  isAdcosWebhookEventType,
  isAdcosWebhookResourceKind,
  parseAdcosContractState,
  parseAdcosEnvironment,
  parseAdcosErrorCode,
  parseAdcosExecutionStatus,
  parseAdcosOperation,
  parseAdcosWebhookEventType,
  parseAdcosWebhookResourceKind,
  type AdcosContractState,
  type AdcosEnvironment,
  type AdcosErrorCode,
  type AdcosExecutionStatus,
  type AdcosOperation,
  type AdcosWebhookEventType,
  type AdcosWebhookResourceKind,
} from "../src/index.js";

/**
 * RL-030: every enum is CLOSED. Compile-time exhaustiveness is enforced by
 * switch functions without a default branch - adding a member without
 * updating the switch breaks `pnpm typecheck` (RL-LOCK-018).
 */
function exhaustiveContractState(state: AdcosContractState): number {
  switch (state) {
    case "INTENT":
      return 1;
    case "OFFER_SELECTED":
      return 2;
    case "CONTRACT_ACTIVE":
      return 3;
    case "EXECUTION_ACTIVE":
      return 4;
    case "DELIVERY":
      return 5;
    case "ASSURED":
      return 6;
    case "USAGE_FINAL":
      return 7;
    case "SETTLEMENT_PENDING":
      return 8;
    case "SETTLED":
      return 9;
    case "DEGRADED":
      return 10;
    case "TERMINATED":
      return 11;
    case "EXPIRED":
      return 12;
    case "FAILED":
      return 13;
  }
}

function exhaustiveExecutionStatus(status: AdcosExecutionStatus): number {
  switch (status) {
    case "not-started":
      return 1;
    case "permitted":
      return 2;
    case "executing":
      return 3;
    case "delivering":
      return 4;
    case "delivered-assured":
      return 5;
    case "degraded":
      return 6;
    case "usage-accounted":
      return 7;
    case "closed":
      return 8;
  }
}

function exhaustiveEventType(type: AdcosWebhookEventType): number {
  switch (type) {
    case "connectivity_intent.created":
      return 1;
    case "connectivity_contract.offers_selected":
      return 2;
    case "connectivity_contract.activated":
      return 3;
    case "connectivity_contract.terminated":
      return 4;
    case "connectivity_contract.state_changed":
      return 5;
    case "connectivity_lease.granted":
      return 6;
    case "connectivity_lease.renewed":
      return 7;
    case "connectivity_lease.revoked":
      return 8;
    case "webhook_endpoint.registered":
      return 9;
  }
}

function exhaustiveResourceKind(kind: AdcosWebhookResourceKind): number {
  switch (kind) {
    case "connectivity_intent":
      return 1;
    case "connectivity_contract":
      return 2;
    case "connectivity_lease":
      return 3;
    case "webhook_endpoint":
      return 4;
  }
}

function exhaustiveEnvironment(environment: AdcosEnvironment): number {
  switch (environment) {
    case "sandbox":
      return 1;
    case "production":
      return 2;
  }
}

function exhaustiveErrorCode(code: AdcosErrorCode): number {
  switch (code) {
    case "invalid-input":
      return 1;
    case "route-unknown":
      return 2;
    case "authentication-invalid":
      return 3;
    case "authentication-expired":
      return 4;
    case "environment-mismatch":
      return 5;
    case "capability-denied":
      return 6;
    case "version-unsupported":
      return 7;
    case "rate-limited":
      return 8;
    case "idempotency-key-required":
      return 9;
    case "idempotency-conflict":
      return 10;
    case "pagination-invalid":
      return 11;
    case "filter-invalid":
      return 12;
    case "resource-unknown":
      return 13;
    case "webhook-signature-invalid":
      return 14;
    case "webhook-timestamp-stale":
      return 15;
    case "webhook-delivery-unknown":
      return 16;
    case "store-failed":
      return 17;
    case "journal-corrupt":
      return 18;
  }
}

function exhaustiveOperation(operation: AdcosOperation): number {
  switch (operation) {
    case "application_self":
      return 1;
    case "intent_create":
      return 2;
    case "intent_list":
      return 3;
    case "intent_get":
      return 4;
    case "intent_lifecycle_get":
      return 5;
    case "offers_accept":
      return 6;
    case "contract_activate":
      return 7;
    case "contract_list":
      return 8;
    case "contract_get":
      return 9;
    case "contract_usage_get":
      return 10;
    case "contract_assurance_get":
      return 11;
    case "contract_terminate":
      return 12;
    case "lease_grant":
      return 13;
    case "lease_list":
      return 14;
    case "lease_get":
      return 15;
    case "lease_renew":
      return 16;
    case "lease_revoke":
      return 17;
    case "webhook_endpoint_list":
      return 18;
    case "webhook_endpoint_create":
      return 19;
    case "webhook_endpoint_get":
      return 20;
    case "webhook_endpoint_deliveries_list":
      return 21;
  }
}

describe("closed ADCOS v2 enums (RL-030)", () => {
  it("contract states: exactly the 13 documented states; parse rejects unknown", () => {
    expect(ADCOS_CONTRACT_STATES).toHaveLength(13);
    expect(ADCOS_CONTRACT_STATES).toEqual([
      "INTENT",
      "OFFER_SELECTED",
      "CONTRACT_ACTIVE",
      "EXECUTION_ACTIVE",
      "DELIVERY",
      "ASSURED",
      "USAGE_FINAL",
      "SETTLEMENT_PENDING",
      "SETTLED",
      "DEGRADED",
      "TERMINATED",
      "EXPIRED",
      "FAILED",
    ]);
    for (const state of ADCOS_CONTRACT_STATES) {
      expect(isAdcosContractState(state)).toBe(true);
      expect(parseAdcosContractState(state)).toBe(state);
      expect(exhaustiveContractState(state)).toBeGreaterThan(0);
    }
    expect(isAdcosContractState("ACTIVE")).toBe(false);
    expect(isAdcosContractState("intent")).toBe(false);
    expect(() => parseAdcosContractState("ACTIVE")).toThrow(ValidationError);
    expect(() => parseAdcosContractState(null)).toThrow(ValidationError);
  });

  it("execution statuses: exactly the 8 documented values; parse rejects unknown", () => {
    expect(ADCOS_EXECUTION_STATUSES).toEqual([
      "not-started",
      "permitted",
      "executing",
      "delivering",
      "delivered-assured",
      "degraded",
      "usage-accounted",
      "closed",
    ]);
    for (const status of ADCOS_EXECUTION_STATUSES) {
      expect(isAdcosExecutionStatus(status)).toBe(true);
      expect(parseAdcosExecutionStatus(status)).toBe(status);
      expect(exhaustiveExecutionStatus(status)).toBeGreaterThan(0);
    }
    expect(isAdcosExecutionStatus("started")).toBe(false);
    expect(() => parseAdcosExecutionStatus("delivered")).toThrow(ValidationError);
  });

  it("webhook event types: exactly the 9 documented types; parse rejects unknown", () => {
    expect(ADCOS_WEBHOOK_EVENT_TYPES).toHaveLength(9);
    for (const type of ADCOS_WEBHOOK_EVENT_TYPES) {
      expect(isAdcosWebhookEventType(type)).toBe(true);
      expect(parseAdcosWebhookEventType(type)).toBe(type);
      expect(exhaustiveEventType(type)).toBeGreaterThan(0);
    }
    expect(isAdcosWebhookEventType("connectivity_session.created")).toBe(false);
    expect(() => parseAdcosWebhookEventType("connectivity_contract.something")).toThrow(
      ValidationError,
    );
  });

  it("webhook resource kinds: exactly the kinds derived from the event types", () => {
    expect(ADCOS_WEBHOOK_RESOURCE_KINDS).toEqual([
      "connectivity_intent",
      "connectivity_contract",
      "connectivity_lease",
      "webhook_endpoint",
    ]);
    for (const kind of ADCOS_WEBHOOK_RESOURCE_KINDS) {
      expect(isAdcosWebhookResourceKind(kind)).toBe(true);
      expect(parseAdcosWebhookResourceKind(kind)).toBe(kind);
      expect(exhaustiveResourceKind(kind)).toBeGreaterThan(0);
    }
    expect(isAdcosWebhookResourceKind("connectivity_session")).toBe(false);
    expect(isAdcosWebhookResourceKind("network_path")).toBe(false);
    expect(() => parseAdcosWebhookResourceKind("network_path")).toThrow(ValidationError);
  });

  it("environments: exactly sandbox and production; parse rejects unknown", () => {
    expect(ADCOS_ENVIRONMENTS).toEqual(["sandbox", "production"]);
    for (const environment of ADCOS_ENVIRONMENTS) {
      expect(isAdcosEnvironment(environment)).toBe(true);
      expect(parseAdcosEnvironment(environment)).toBe(environment);
      expect(exhaustiveEnvironment(environment)).toBeGreaterThan(0);
    }
    expect(isAdcosEnvironment("staging")).toBe(false);
    expect(() => parseAdcosEnvironment("dev")).toThrow(ValidationError);
  });

  it("error codes: exactly the 18 documented codes; parse rejects unknown", () => {
    expect(ADCOS_ERROR_CODES).toHaveLength(18);
    expect(ADCOS_ERROR_CODES.slice(0, 5)).toEqual([
      "invalid-input",
      "route-unknown",
      "authentication-invalid",
      "authentication-expired",
      "environment-mismatch",
    ]);
    for (const code of ADCOS_ERROR_CODES) {
      expect(isAdcosErrorCode(code)).toBe(true);
      expect(parseAdcosErrorCode(code)).toBe(code);
      expect(exhaustiveErrorCode(code)).toBeGreaterThan(0);
    }
    expect(isAdcosErrorCode("not-found")).toBe(false);
    expect(() => parseAdcosErrorCode("teapot")).toThrow(ValidationError);
  });

  it("operations: exactly the 21 route operations; parse rejects unknown", () => {
    expect(ADCOS_OPERATIONS).toHaveLength(21);
    for (const operation of ADCOS_OPERATIONS) {
      expect(isAdcosOperation(operation)).toBe(true);
      expect(parseAdcosOperation(operation)).toBe(operation);
      expect(exhaustiveOperation(operation)).toBeGreaterThan(0);
    }
    expect(isAdcosOperation("session_get")).toBe(false);
    expect(() => parseAdcosOperation("session_get")).toThrow(ValidationError);
  });
});
