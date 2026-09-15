import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import {
  ADCOS_PAGINATION_DEFAULT_LIMIT,
  ADCOS_PAGINATION_MAX_LIMIT,
  ADCOS_ROUTES,
  adcosRouteForOperation,
  isAdcosMutationOperation,
  parseAdcosListQuery,
} from "../src/index.js";

describe("pagination (RL-030)", () => {
  it("default limit 20, max limit 100", () => {
    expect(ADCOS_PAGINATION_DEFAULT_LIMIT).toBe(20);
    expect(ADCOS_PAGINATION_MAX_LIMIT).toBe(100);
  });

  it("parses valid queries: limit, cursor, equality filters", () => {
    expect(parseAdcosListQuery(undefined)).toEqual({});
    expect(parseAdcosListQuery({})).toEqual({});
    expect(parseAdcosListQuery({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseAdcosListQuery({ limit: 100 })).toEqual({ limit: 100 });
    expect(parseAdcosListQuery({ cursor: "opaque-cursor" })).toEqual({ cursor: "opaque-cursor" });
    expect(parseAdcosListQuery({ filters: { state: "CONTRACT_ACTIVE" } })).toEqual({
      filters: { state: "CONTRACT_ACTIVE" },
    });
    expect(
      parseAdcosListQuery({ limit: 20, cursor: "c", filters: { environment: "production" } }),
    ).toEqual({ limit: 20, cursor: "c", filters: { environment: "production" } });
  });

  it("rejects out-of-range limits, bad cursors, non-string filter values, unknown fields", () => {
    for (const limit of [0, -1, 101, 2.5, "20"]) {
      expect(() => parseAdcosListQuery({ limit })).toThrow(ValidationError);
    }
    expect(() => parseAdcosListQuery({ cursor: "" })).toThrow(ValidationError);
    expect(() => parseAdcosListQuery({ cursor: 42 })).toThrow(ValidationError);
    expect(() => parseAdcosListQuery({ filters: { state: 7 } })).toThrow(ValidationError);
    expect(() => parseAdcosListQuery({ offset: 10 })).toThrow(ValidationError);
  });
});

describe("route table (RL-030)", () => {
  it("contains exactly the 21 documented v2 routes with unique (method, path) pairs", () => {
    expect(ADCOS_ROUTES).toHaveLength(21);
    const keys = ADCOS_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(21);
  });

  it("paths match the documented v2 route list verbatim", () => {
    const paths = ADCOS_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(paths.sort()).toEqual(
      [
        "GET application",
        "POST intents",
        "GET intents",
        "GET intents/{id}",
        "GET intents/{id}/lifecycle",
        "POST intents/{id}/offers",
        "POST intents/{id}/activation",
        "GET contracts",
        "GET contracts/{id}",
        "GET contracts/{id}/usage",
        "GET contracts/{id}/assurance",
        "POST contracts/{id}/termination",
        "POST contracts/{id}/leases",
        "GET leases",
        "GET leases/{id}",
        "POST leases/{id}/renewal",
        "POST leases/{id}/revocation",
        "GET webhook-endpoints",
        "POST webhook-endpoints",
        "GET webhook-endpoints/{id}",
        "GET webhook-endpoints/{id}/deliveries",
      ].sort(),
    );
  });

  it("every mutation is a POST and every POST is a mutation (idempotency key required)", () => {
    for (const route of ADCOS_ROUTES) {
      expect(route.mutation).toBe(route.method === "POST");
    }
    const mutations = ADCOS_ROUTES.filter((route) => route.mutation);
    expect(mutations).toHaveLength(8);
    for (const route of mutations) {
      expect(isAdcosMutationOperation(route.operation)).toBe(true);
    }
    expect(isAdcosMutationOperation("intent_get")).toBe(false);
  });

  it("the five v2-documented operation names appear verbatim", () => {
    for (const operation of [
      "application_self",
      "intent_create",
      "offers_accept",
      "contract_activate",
      "lease_grant",
    ] as const) {
      expect(adcosRouteForOperation(operation).operation).toBe(operation);
    }
  });

  it("operation lookup fails closed for unknown operations", () => {
    expect(() => adcosRouteForOperation("session_get" as never)).toThrow(ValidationError);
  });
});
