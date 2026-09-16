/**
 * RL-LOCK-003 / RL-LOCK-004 / RL-LOCK-005 conformance suite: no duplicate
 * identity, session or path/routing authority.
 *
 * RoamLink may own customer/user/org/device IDENTITY (the experience
 * domain) but must never redefine ADCOS NodeID, credentials, cryptographic
 * identity (003), logical sessions (004) or NetworkPath/routing state
 * (005). ADCOS-owned things enter RoamLink ONLY as opaque foreign
 * references in explicitly named fields, and as READ-ONLY projections.
 *
 * GREEN PROOFS:
 *  - the identity owner (packages/auth) and the device registry
 *    (domain-experience) have closed record vocabularies with no ADCOS
 *    identity fields, and never import the ADCOS packages;
 *  - the foreign-reference types exist ONLY as opaque branded references
 *    (they carry no authority semantics of their own);
 *  - the session/path authority surfaces are read-only by construction:
 *    the commerce evidence port exposes `get` only, and the projection
 *    store's writer is captured inside the reconciliation boundary.
 *
 * NEGATIVE PROOFS (red-on-violation, per lock):
 *  - 003: a User / Device record carrying an ADCOS identity field
 *    (`adcosNodeId`, `nodeCredentials`) is REJECTED by the closed record
 *    constructors;
 *  - 004/005: session- and path-shaped canonical resource kinds are
 *    rejected by the projection record parser and by the webhook event
 *    parser (a forged event referencing a session/path kind cannot even be
 *    admitted).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { User } from "@roamlink/auth";
import { Device } from "@roamlink/domain-experience";
import { parseAdcosProjectionResourceType } from "@roamlink/projections";
import { ADCOS_ROUTES, parseAdcosWebhookEvent } from "@roamlink/adcos";
import { fixtureUserId } from "@roamlink/testkit";
import { overlayFor, readSourceFiles, toggleHint, violationEnabled } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const T0 = "2026-01-15T08:30:00.000Z";

const USER_BASE = {
  userId: fixtureUserId(1) as unknown as string,
  email: "traveler@example.com",
  displayName: "Traveler",
  status: "active",
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

const DEVICE_BASE = {
  deviceId: "00000000-0000-4000-8000-0000000000aa",
  owningUserId: fixtureUserId(2) as unknown as string,
  platform: { family: "ios", platformVersion: "18.2" },
  status: "enrolled",
  enrolledAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

describe("RL-LOCK-003: no duplicate identity authority", () => {
  it("green: RoamLink identity records accept only the closed RoamLink field vocabulary", () => {
    expect(new User({ ...USER_BASE }).userId).toBe(USER_BASE.userId);
    expect(new Device({ ...DEVICE_BASE }).deviceId).toBe(DEVICE_BASE.deviceId);
  });

  it("negative proof: a User carrying an ADCOS identity field is rejected (red when admitted)", () => {
    const violating = {
      ...USER_BASE,
      adcosNodeId: "node-9f1c",
    };
    if (violationEnabled("RL-LOCK-003")) {
      expect(() => new User(violating)).not.toThrow();
    } else {
      expect(() => new User(violating)).toThrow(/unknown field/);
    }
  });

  it("negative proof: a User carrying ADCOS credentials is rejected (red when admitted)", () => {
    const violating = {
      ...USER_BASE,
      adcosCredentials: { keyId: "k", secret: "s" },
    };
    if (violationEnabled("RL-LOCK-003")) {
      expect(() => new User(violating)).not.toThrow();
    } else {
      expect(() => new User(violating)).toThrow(/unknown field/);
    }
  });

  it("negative proof: a Device carrying a network-node identity is rejected (red when admitted)", () => {
    const violating = {
      ...DEVICE_BASE,
      adcosNetworkNode: "node-42",
    };
    if (violationEnabled("RL-LOCK-003")) {
      expect(() => new Device(violating)).not.toThrow();
    } else {
      expect(() => new Device(violating)).toThrow(/unknown field/);
    }
  });

  it("green: the identity owners never import the ADCOS boundary packages", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/auth", "packages/domain-experience"], overlayFor("RL-LOCK-003"));
    const offenders = files
      .filter((file) => file.path.includes("/src/"))
      .filter(
        (file) =>
          /from\s+["']@roamlink\/adcos["']/.test(file.content) ||
          /from\s+["']@roamlink\/integration["']/.test(file.content),
      )
      .map((file) => file.path);
    expect(
      offenders,
      `${toggleHint("RL-LOCK-003")} - identity owners must not depend on ADCOS identity semantics`,
    ).toEqual([]);
  });
});

describe("RL-LOCK-004: no duplicate session authority", () => {
  it("green: sessions exist only as opaque foreign references, never as RoamLink state", () => {
    // The projection vocabulary (the read surface) has no session kind...
    expect(() => parseAdcosProjectionResourceType("connectivity_session")).toThrow(
      /closed v2 canonical resource types/,
    );
    // ...and the pinned v2 route table exposes no session lifecycle ROUTE
    // (the structured table is asserted in the LOCK-001 suite; here the
    // route VALUES are re-checked for the session family specifically).
    for (const route of ADCOS_ROUTES) {
      expect(`${route.path} ${route.operation}`).not.toMatch(/session/i);
    }
  });

  it("negative proof: a session-shaped canonical resource kind is rejected (red when admitted)", () => {
    if (violationEnabled("RL-LOCK-004")) {
      expect(() => parseAdcosProjectionResourceType("connectivity_session")).not.toThrow();
    } else {
      expect(() => parseAdcosProjectionResourceType("connectivity_session")).toThrow(
        /closed v2 canonical resource types/,
      );
    }
  });

  it("negative proof: a forged webhook event about a session resource cannot even be admitted", () => {
    const forged = {
      event_id: "evt-1",
      event_type: "connectivity_session.activated",
      resource_id: "session-1",
      resource_kind: "connectivity_session",
      resource_version: 1,
      occurred_at: T0,
      api_version: "2.0",
      environment: "sandbox",
      correlation_id: "corr-1",
    };
    if (violationEnabled("RL-LOCK-004")) {
      expect(() => parseAdcosWebhookEvent(forged)).not.toThrow();
    } else {
      expect(() => parseAdcosWebhookEvent(forged)).toThrow(
        /resource_kind|outside the closed vocabulary|must be one of/i,
      );
    }
  });
});

describe("RL-LOCK-005: no duplicate path/routing authority", () => {
  it("green: path-shaped canonical resource kinds are rejected by the projection vocabulary", () => {
    for (const invented of ["network_path", "connectivity_path", "path_selection"]) {
      expect(() => parseAdcosProjectionResourceType(invented)).toThrow(
        /closed v2 canonical resource types/,
      );
    }
  });

  it("negative proof: a path-shaped canonical resource kind is rejected (red when admitted)", () => {
    if (violationEnabled("RL-LOCK-005")) {
      expect(() => parseAdcosProjectionResourceType("network_path")).not.toThrow();
    } else {
      expect(() => parseAdcosProjectionResourceType("network_path")).toThrow(
        /closed v2 canonical resource types/,
      );
    }
  });

  it("green: the compiled ADCOS intent command never selects paths or routes", () => {
    // The pure command compiler (integration surface, RL-031) is checked
    // structurally: its request shape vocabulary contains only
    // technology-neutral requirement/validity/termination/beneficiary
    // members - no path/route/network selection.
    const files = readSourceFiles(REPO_ROOT, ["packages/integration/src"], []);
    const command = files.find((file) => file.path.endsWith("intent-command.ts"));
    expect(command).toBeDefined();
    for (const forbidden of [/hard_?route/, /network_?path/, /path_?selection/, /preferred_?route/]) {
      expect(forbidden.test(command?.content ?? "")).toBe(false);
    }
  });

  it("green: the commerce evidence seam is read-only (a get-only port; no command surface)", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/commerce-connectivity/src"], []);
    const source = files
      .filter((file) => file.path.endsWith("evidence-source.ts"))
      .map((file) => file.content)
      .join("\n");
    expect(source).toMatch(/export interface DeliveryEvidenceSource/);
    expect(source).toMatch(/get\(/);
    expect(source).not.toMatch(/createPath|selectPath|commitPath|writePath|mutate/);
  });
});
