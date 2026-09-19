/**
 * Enterprise workspace read-contract tests (RL-104, additive).
 *
 * Locks the app-contract surface the customer workspace renders:
 *  - the typed client reads /v1/enterprise/workspace through the fake and
 *    the parser returns the mirrored closed vocabularies;
 *  - personal-scope tenants fail closed (403-shaped, no existence oracle);
 *  - the parser rejects unknown fields and out-of-vocabulary states
 *    fail-closed (never a guessed workspace);
 *  - null sections are the honest not-started states.
 */
import { describe, expect, it } from "vitest";

import {
  createInMemoryApi,
  ENTERPRISE_CONNECTOR_RESOURCE_STATES,
  ENTERPRISE_ENROLLMENT_RESOURCE_STATES,
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

  it("a tenant without enterprise fixtures returns honest null sections", async () => {
    const client = buildClient(OTHER_ACTOR, OTHER_TENANT);
    const workspace = await client.getEnterpriseWorkspace();
    expect(workspace.organization?.name).toBe("Beta Roaming Ltd");
    expect(workspace.enrollment).toBeNull();
    expect(workspace.connector).toBeNull();
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
  });
});
