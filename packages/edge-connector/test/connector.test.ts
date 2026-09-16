/**
 * RL-044 tests: capability negotiation (incl. the observation-only
 * fallback), configuration delivery (typed, secret-free, expiry-aware) and
 * the graceful-degradation guarantee (RL-LOCK-018: the tests fail when the
 * degradation floor stops working, not only when the happy path breaks).
 */
import { describe, expect, it } from "vitest";
import { fixtureUtcInstant } from "@roamlink/testkit";

import {
  InMemoryEnterpriseEdgeConnector,
  negotiateConnectorCapabilities,
  parseEnterpriseConfiguration,
  parseEnterpriseConnectorCapability,
  isEnterpriseConfigurationApplicable,
} from "../src/index.js";

const T0 = fixtureUtcInstant();
const T_PLUS_1H = fixtureUtcInstant(60 * 60 * 1000);
const T_PLUS_2H = fixtureUtcInstant(2 * 60 * 60 * 1000);

describe("the closed capability vocabulary", () => {
  it("has exactly the six spec-named capabilities", () => {
    expect(() => parseEnterpriseConnectorCapability("mdm-managed-configuration")).not.toThrow();
    expect(() => parseEnterpriseConnectorCapability("system-extension")).not.toThrow();
    expect(() => parseEnterpriseConnectorCapability("vpn-network-extension")).not.toThrow();
    expect(() => parseEnterpriseConnectorCapability("enterprise-connector")).not.toThrow();
    expect(() => parseEnterpriseConnectorCapability("observation")).not.toThrow();
    expect(() => parseEnterpriseConnectorCapability("user-guided-actions")).not.toThrow();
    expect(() => parseEnterpriseConnectorCapability("teleportation")).toThrowError(
      /closed enterprise-connector capability vocabulary/,
    );
  });
});

describe("negotiateConnectorCapabilities (pure)", () => {
  it("grants the intersection and denies the rest with typed fallbacks", () => {
    const result = negotiateConnectorCapabilities(
      ["vpn-network-extension", "mdm-managed-configuration", "enterprise-connector"],
      ["vpn-network-extension", "observation", "user-guided-actions"],
    );
    expect(result.granted).toEqual(["vpn-network-extension"]);
    expect(result.denials).toEqual([
      {
        capability: "mdm-managed-configuration",
        reason: "capability-not-supported-by-connector",
        fallback: "user-guided-actions",
      },
      {
        capability: "enterprise-connector",
        reason: "capability-not-supported-by-connector",
        fallback: "user-guided-actions",
      },
    ]);
    expect(result.operatingMode).toBe("enterprise");
    expect(result.invalidRequestCount).toBe(0);
  });

  it("deduplicates repeated requests (idempotent negotiation)", () => {
    const result = negotiateConnectorCapabilities(
      ["observation", "observation", "user-guided-actions"],
      ["observation", "user-guided-actions"],
    );
    expect(result.granted).toEqual(["observation", "user-guided-actions"]);
    expect(result.denials).toHaveLength(0);
  });

  it("degrades to observation-only when nothing else is available (the hard floor)", () => {
    const result = negotiateConnectorCapabilities(
      ["mdm-managed-configuration", "enterprise-connector", "observation"],
      ["observation"],
    );
    expect(result.granted).toEqual(["observation"]);
    expect(result.operatingMode).toBe("observation-only");
    expect(result.denials.map((denial) => denial.fallback)).toEqual([
      "user-guided-actions",
      "user-guided-actions",
    ]);
  });

  it("the user-guided mode is observation + user-guided actions with no enterprise capabilities", () => {
    const result = negotiateConnectorCapabilities(
      ["observation", "user-guided-actions"],
      ["observation", "user-guided-actions"],
    );
    expect(result.operatingMode).toBe("user-guided");
  });

  it("counts out-of-vocabulary requests without echoing them (RL-LOCK-016)", () => {
    const result = negotiateConnectorCapabilities(
      ["observation", "carrier-backdoor", 42],
      ["observation"],
    );
    expect(result.invalidRequestCount).toBe(2);
    expect(result.granted).toEqual(["observation"]);
    expect(JSON.stringify(result)).not.toContain("carrier-backdoor");
  });

  it("is deterministic (same inputs, same result)", () => {
    const first = negotiateConnectorCapabilities(["vpn-network-extension"], ["observation"]);
    const second = negotiateConnectorCapabilities(["vpn-network-extension"], ["observation"]);
    expect(first).toEqual(second);
  });
});

describe("the in-memory fake connector - configuration delivery", () => {
  function mdmConnector(): InMemoryEnterpriseEdgeConnector {
    return new InMemoryEnterpriseEdgeConnector({
      capabilities: ["mdm-managed-configuration", "observation", "user-guided-actions"],
      configurations: [
        {
          configurationId: "cfg-enterprise-1",
          contractVersion: "0.1",
          revision: 1,
          issuedAt: T0,
          expiresAt: T_PLUS_2H,
          policies: {
            "preferred-network-priority": "wifi-first",
            "metered-override-allowed": false,
            "max-observation-batch": 50,
            "legacy-tag": null,
          },
        },
        {
          configurationId: "cfg-enterprise-2",
          contractVersion: "0.1",
          revision: 2,
          issuedAt: T_PLUS_1H,
          expiresAt: null,
          policies: { "preferred-network-priority": "cellular-fallback" },
        },
      ],
    });
  }

  it("delivers the latest applicable configuration revision", async () => {
    const connector = mdmConnector();
    const configuration = await connector.retrieveConfiguration(T_PLUS_1H);
    expect(configuration?.revision).toBe(2);
    expect(configuration?.policies["preferred-network-priority"]).toBe("cellular-fallback");
  });

  it("delivers only applicable (issued, unexpired) configurations", async () => {
    const connector = mdmConnector();
    const atT0 = await connector.retrieveConfiguration(T0);
    expect(atT0?.revision).toBe(1); // revision 2 not yet issued at T0
    const late = await connector.retrieveConfiguration(fixtureUtcInstant(3 * 60 * 60 * 1000));
    expect(late?.revision).toBe(2); // revision 1 expired; revision 2 has no expiry
  });

  it("returns an honest null when MDM configuration is not supported", async () => {
    const connector = new InMemoryEnterpriseEdgeConnector({
      capabilities: ["observation", "user-guided-actions"],
    });
    expect(await connector.retrieveConfiguration(T0)).toBeNull();
  });

  it("rejects secret-shaped policy keys fail-closed (RL-LOCK-016)", () => {
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-bad-1",
        contractVersion: "0.1",
        revision: 1,
        issuedAt: T0,
        expiresAt: null,
        policies: { "vpn-shared-secret": "hunter2" },
      }),
    ).toThrowError(/credentials never travel through managed configuration/);
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-bad-2",
        contractVersion: "0.1",
        revision: 1,
        issuedAt: T0,
        expiresAt: null,
        policies: { password: "nope" },
      }),
    ).toThrowError(/RL-LOCK-016/);
  });

  it("rejects malformed configurations (unknown fields, bad keys, nesting, bad versions)", () => {
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-x",
        contractVersion: "0.1",
        revision: 0,
        issuedAt: T0,
        expiresAt: null,
        policies: {},
      }),
    ).toThrowError(/revision/);
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-x",
        contractVersion: "9.9",
        revision: 1,
        issuedAt: T0,
        expiresAt: null,
        policies: {},
      }),
    ).toThrowError(/contractVersion/);
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-x",
        contractVersion: "0.1",
        revision: 1,
        issuedAt: T0,
        expiresAt: null,
        policies: { nested: { deep: 1 } },
      }),
    ).toThrowError(/no secrets, no nesting/);
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-x",
        contractVersion: "0.1",
        revision: 1,
        issuedAt: T0,
        expiresAt: T0,
        policies: {},
      }),
    ).toThrowError(/strictly after issuedAt/);
    expect(() =>
      parseEnterpriseConfiguration({
        configurationId: "cfg-x",
        contractVersion: "0.1",
        revision: 1,
        issuedAt: T0,
        expiresAt: null,
        extra: true,
        policies: {},
      }),
    ).toThrowError(/unknown field/);
  });

  it("configuration applicability honors issuance and expiry instants", () => {
    const configuration = parseEnterpriseConfiguration({
      configurationId: "cfg-app-1",
      contractVersion: "0.1",
      revision: 1,
      issuedAt: T0,
      expiresAt: T_PLUS_1H,
      policies: {},
    });
    expect(isEnterpriseConfigurationApplicable(configuration, T0)).toBe(true);
    expect(isEnterpriseConfigurationApplicable(configuration, T_PLUS_1H)).toBe(true);
    expect(
      isEnterpriseConfigurationApplicable(configuration, fixtureUtcInstant(60 * 60 * 1000 + 1)),
    ).toBe(false);
  });
});

describe("the fake connector - graceful degradation wiring", () => {
  it("the default connector is the degradation floor (observation + user-guided)", async () => {
    const connector = new InMemoryEnterpriseEdgeConnector();
    expect(connector.availableCapabilities()).toEqual(["observation", "user-guided-actions"]);
    const negotiation = connector.negotiate([
      "mdm-managed-configuration",
      "vpn-network-extension",
      "observation",
      "user-guided-actions",
    ]);
    expect(negotiation.operatingMode).toBe("user-guided");
    expect(negotiation.granted).toEqual(["observation", "user-guided-actions"]);
    expect(await connector.retrieveConfiguration(T0)).toBeNull();
  });

  it("an MDM-capable connector negotiates enterprise mode", () => {
    const connector = new InMemoryEnterpriseEdgeConnector({
      capabilities: ["mdm-managed-configuration", "system-extension", "observation", "user-guided-actions"],
    });
    const negotiation = connector.negotiate(["mdm-managed-configuration", "system-extension"]);
    expect(negotiation.operatingMode).toBe("enterprise");
    expect(negotiation.granted).toEqual(["mdm-managed-configuration", "system-extension"]);
  });
});
