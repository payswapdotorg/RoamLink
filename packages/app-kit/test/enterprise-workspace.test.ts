/**
 * Enterprise workspace read-contract tests (RL-104, additive).
 *
 * Locks the app-contract surface the customer workspace renders:
 *  - the typed client reads /v1/enterprise/workspace through the fake and
 *    the parser returns the mirrored closed vocabularies;
 *  - personal-scope tenants fail closed (403-shaped, no existence oracle);
 *  - the parser rejects unknown fields and out-of-vocabulary states
 *    fail-closed (never a guessed workspace);
 *  - null sections are the honest not-started states;
 *  - PA-007 (closes RL-115-F7): the READ-ONLY organization policy section
 *    rides the workspace read additively (an older payload without it
 *    parses to the honest null section - RL-LOCK-017), with its mirrored
 *    state/source vocabularies, the freshness pairing evaluated at the
 *    query instant, and the explicit absence states kept separate.
 */
import { describe, expect, it } from "vitest";

import {
  createInMemoryApi,
  ENTERPRISE_CONNECTOR_RESOURCE_STATES,
  ENTERPRISE_ENROLLMENT_RESOURCE_STATES,
  ENTERPRISE_POLICY_RESOURCE_SOURCES,
  ENTERPRISE_POLICY_RESOURCE_STATES,
  fakeApiSeed,
  isApiClientError,
  parseEnterpriseWorkspaceResource,
  RoamLinkApiClient,
} from "../src/index.js";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OTHER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000004";

function buildClient(actor: string, tenant: string) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const ids = new DeterministicUuidGenerator(9000);
  const fake = createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => ids.next(),
  });
  return new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: actor, tenantId: tenant },
    ids: new DeterministicUuidGenerator(9500),
  });
}

describe("the enterprise workspace read contract", () => {
  it("reads the seeded workspace with the mirrored vocabularies verbatim", async () => {
    const client = buildClient(MEMBER_ACTOR, TENANT);
    const workspace = await client.getEnterpriseWorkspace();
    expect(workspace.organization?.name).toBe("Acme Roaming Corp");
    expect(workspace.organization?.status).toBe("active");
    expect(workspace.enrollment?.state).toBe("active");
    expect(ENTERPRISE_ENROLLMENT_RESOURCE_STATES).toContain(workspace.enrollment?.state);
    expect(workspace.connector?.state).toBe("provisioned");
    expect(ENTERPRISE_CONNECTOR_RESOURCE_STATES).toContain(workspace.connector?.state);
    expect(workspace.presentedAt).toBe("2025-01-06T09:45:00.000Z");
  });

  it("reads the seeded READ-ONLY policy section with its facts and mirrored vocabularies (PA-007, RL-115-F7)", async () => {
    const client = buildClient(MEMBER_ACTOR, TENANT);
    const workspace = await client.getEnterpriseWorkspace();
    const policy = workspace.policy;
    expect(policy).not.toBeNull();
    expect(ENTERPRISE_POLICY_RESOURCE_STATES).toContain(policy?.state);
    expect(ENTERPRISE_POLICY_RESOURCE_SOURCES).toContain(policy?.source);
    expect(policy?.state).toBe("configured");
    expect(policy?.source).toBe("organization-administration");
    expect(policy?.policyVersion).toBe("2025-01");
    expect(policy?.summary).toContain("capped daily spend");
    expect(policy?.effectiveAt).toBe("2024-07-01T00:00:00.000Z");
    // The freshness pairing is evaluated at the query instant (the
    // deterministic clock reads 09:45; the guarantee runs to 10:00).
    expect(policy?.freshness.freshnessState).toBe("FRESH");
    expect(policy?.freshness.observedAt).toBe("2025-01-06T09:00:00.000Z");
    expect(policy?.freshness.freshUntil).toBe("2025-01-06T10:00:00.000Z");
  });

  it("a tenant without enterprise fixtures returns honest null sections", async () => {
    const client = buildClient(OTHER_ACTOR, OTHER_TENANT);
    const workspace = await client.getEnterpriseWorkspace();
    expect(workspace.organization?.name).toBe("Beta Roaming Ltd");
    expect(workspace.enrollment).toBeNull();
    expect(workspace.connector).toBeNull();
    // PA-007: no policy record composed either - the honest null section
    // ("not available"), DISTINCT from a record asserting absence.
    expect(workspace.policy).toBeNull();
  });

  it("personal-scope tenants fail closed as typed unauthorized errors", async () => {
    const client = buildClient(MEMBER_ACTOR, `usr:${MEMBER_ACTOR.slice(4)}`);
    await expect(client.getEnterpriseWorkspace()).rejects.toSatisfy((error: unknown) => {
      return isApiClientError(error) && error.status === 403;
    });
  });

  it("the parser rejects unknown fields and out-of-vocabulary states fail-closed", () => {
    expect(() =>
      parseEnterpriseWorkspaceResource({
        presentedAt: "2025-01-06T09:45:00.000Z",
        organization: null,
        enrollment: null,
        connector: null,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseEnterpriseWorkspaceResource({
        presentedAt: "2025-01-06T09:45:00.000Z",
        organization: null,
        enrollment: { state: "provisioned" },
        connector: null,
      }),
    ).toThrow();
    expect(() =>
      parseEnterpriseWorkspaceResource({
        presentedAt: "2025-01-06T09:45:00.000Z",
        organization: null,
        enrollment: null,
        connector: { provisioningId: "c1", state: "rejected", createdAt: "2025-01-06T09:00:00.000Z", updatedAt: "2025-01-06T09:00:00.000Z" },
      }),
    ).toThrow();
    // PA-007: a malformed policy section fails closed - an out-of-
    // vocabulary state, an unknown field, a bad source - never a guessed
    // policy. (Content-level invariants - a configured record carrying its
    // summary/version - are enforced by the OWNING domain record parser in
    // packages/enterprise/test/policy.test.ts; the mirror parses the wire
    // shape + closed vocabularies, exactly like the enrollment mirror.)
    expect(() =>
      parseEnterpriseWorkspaceResource({
        presentedAt: "2025-01-06T09:45:00.000Z",
        organization: null,
        enrollment: null,
        connector: null,
        policy: { policyId: "p1", state: "active", source: "organization-administration", freshness: { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" } },
      }),
    ).toThrow();
    expect(() =>
      parseEnterpriseWorkspaceResource({
        presentedAt: "2025-01-06T09:45:00.000Z",
        organization: null,
        enrollment: null,
        connector: null,
        policy: { policyId: "p1", state: "not-configured", source: "someone-else", freshness: { observedAt: "2025-01-06T09:00:00.000Z", receivedAt: "2025-01-06T09:00:00.000Z", freshUntil: "2025-01-06T10:00:00.000Z", freshnessState: "FRESH" }, extra: true },
      }),
    ).toThrow();
    expect(() =>
      parseEnterpriseWorkspaceResource({
        presentedAt: "2025-01-06T09:45:00.000Z",
        organization: null,
        enrollment: null,
        connector: null,
        policy: null,
        unexpected: true,
      }),
    ).toThrow();
  });

  it("the parser accepts the honest all-null shape (nothing started yet)", () => {
    const workspace = parseEnterpriseWorkspaceResource({
      presentedAt: "2025-01-06T09:45:00.000Z",
      organization: null,
      enrollment: null,
      connector: null,
    });
    expect(workspace.organization).toBeNull();
    expect(workspace.enrollment).toBeNull();
    expect(workspace.connector).toBeNull();
    // PA-007 additive tolerance (RL-LOCK-017): an OLDER payload without the
    // policy section still parses - to the honest null section (the
    // workspace surface composes no policy read; never a guessed policy).
    expect(workspace.policy).toBeNull();
  });

  it("parses the explicit policy absence states and the stale freshness pairing (PA-007)", () => {
    const notConfigured = parseEnterpriseWorkspaceResource({
      presentedAt: "2025-01-06T09:45:00.000Z",
      organization: null,
      enrollment: null,
      connector: null,
      policy: {
        policyId: "pppppppp-0000-4000-8000-000000000002",
        state: "not-configured",
        source: "organization-administration",
        freshness: { observedAt: "2025-01-06T09:00:00.000Z", receivedAt: "2025-01-06T09:00:00.000Z", freshUntil: "2025-01-06T10:00:00.000Z", freshnessState: "FRESH" },
      },
    });
    expect(notConfigured.policy?.state).toBe("not-configured");
    expect("summary" in (notConfigured.policy ?? {})).toBe(false);

    const stale = parseEnterpriseWorkspaceResource({
      presentedAt: "2025-01-06T09:45:00.000Z",
      organization: null,
      enrollment: null,
      connector: null,
      policy: {
        policyId: "pppppppp-0000-4000-8000-000000000003",
        state: "configured",
        source: "organization-administration",
        policyVersion: "2024-12",
        summary: "Roam on approved networks.",
        effectiveAt: "2024-07-01T00:00:00.000Z",
        freshness: { observedAt: "2025-01-06T08:00:00.000Z", receivedAt: "2025-01-06T08:00:00.000Z", freshUntil: "2025-01-06T09:30:00.000Z", freshnessState: "STALE" },
      },
    });
    expect(stale.policy?.state).toBe("configured");
    expect(stale.policy?.freshness.freshnessState).toBe("STALE");
  });
});
