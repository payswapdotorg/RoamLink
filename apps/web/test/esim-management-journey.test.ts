/**
 * eSIM management journey tests (RL-115-F1 remediation, PA-001;
 * spec/ux-architecture.md §9 + §15, spec/architecture.md §7).
 *
 * The frozen journey laws these tests lock:
 *  - the journey is REACHABLE from the device detail page (Devices -> Device
 *    -> SIM & Profiles): the device page carries the section + its link;
 *  - the capability truth table renders the three closed eSIM names with
 *    status, evidence class, freshness and the gate preview (RL-LOCK-011);
 *  - blocked actions render the CLOSED manual-guidance map — never a
 *    disabled mystery, and never a silently hidden action;
 *  - install offers activation-code entry where the platform contract
 *    requires it; remove and enable/disable ride the same command envelope;
 *  - every mutation passes the capability gate SERVER-SIDE first: a blocked
 *    gate is a typed CAPABILITY_GATE_BLOCKED failure, never an effect;
 *  - a requested install is NEVER an installed profile: the commanded state
 *    renders its pending command, and only the platform confirmation
 *    (evidence + freshness) flips it to the confirmed state;
 *  - the four-stage command pipeline renders per-stage (accepted/executed
 *    reached, delivered/billable-final not reached for device commands);
 *  - a failed command carries the contextual support escape (RL-103);
 *  - fail-closed reads render the typed error panel;
 *  - novice-path vocabulary stays off the surface.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeDeviceSeed,
  type FakeTenantSeed,
  type HttpTransport,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const LAPTOP_ID = "dddddddd-0000-4000-8000-000000000002";
const SEEDED_ENABLED_PROFILE = "1a2b3c4d-0000-4000-8000-000000000001";
const SEEDED_DISABLED_PROFILE = "1a2b3c4d-0000-4000-8000-000000000002";

/** The jargon that must never reach the customer surface (any state of it). */
const FORBIDDEN_SURFACE_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "ExperienceIntent",
  "NetworkPath",
  "provider adapter",
  "idempotency",
];

function buildApp(options?: { seed?: FakeApiSeed; transport?: HttpTransport }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: options?.transport ?? fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

/** Derives a seed with the Phone's given eSIM capability statuses overridden. */
function phoneCapabilitiesOverride(
  statuses: Partial<
    Record<"esim_profile_install" | "esim_profile_remove" | "esim_profile_enable", string>
  >,
): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const phone = tenant.devices.find((d) => d.deviceId === PHONE_ID);
  const phoneEsim = phone?.esim;
  if (phone === undefined || phoneEsim === undefined) {
    throw new Error("missing seeded Phone eSIM fixture");
  }
  const devices: FakeDeviceSeed[] = tenant.devices.map((device) =>
    device.deviceId !== PHONE_ID
      ? device
      : {
          ...device,
          esim: {
            ...phoneEsim,
            capabilities: phoneEsim.capabilities.map((row) =>
              statuses[row.capability] === undefined
                ? row
                : { ...row, status: statuses[row.capability] as typeof row.status },
            ),
          },
        },
  );
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants, [TENANT]: { ...tenant, devices } };
  return { ...seed, tenants };
}

describe("the journey is reachable from the device detail page (§15 entry + link)", () => {
  it("the device page carries the SIM & Profiles section and its link", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "device", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-device-sim="true"');
    expect(page.html).toContain("SIM &amp; Profiles");
    expect(page.html).toContain(`href="/devices/${PHONE_ID}/sim"`);
    expect(page.html).toContain("Manage SIM &amp; profiles");
  });

  it("the SIM page renders the capability truth, the inventory and the install flow", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-sim-profiles-page="true"');
    expect(page.html).toContain("SIM &amp; Profiles");
    // The closed capability vocabulary renders with status/evidence/gate.
    expect(page.html).toContain('data-esim-capability="esim_profile_install"');
    expect(page.html).toContain('data-esim-capability="esim_profile_remove"');
    expect(page.html).toContain('data-esim-capability="esim_profile_enable"');
    expect(page.html).toContain('data-esim-gate="allow"');
    expect(page.html).toContain("OBSERVED");
    // The profile inventory renders both seeded states with evidence.
    expect(page.html).toContain(`data-esim-profile-id="${SEEDED_ENABLED_PROFILE}"`);
    expect(page.html).toContain(`data-esim-profile-id="${SEEDED_DISABLED_PROFILE}"`);
    expect(page.html).toContain('data-esim-profile-state="enabled"');
    expect(page.html).toContain('data-esim-profile-state="disabled"');
    expect(page.html).toContain("Primary line");
    expect(page.html).toContain("Travel data plan");
    // The install form offers activation-code entry (the platform contract).
    expect(page.html).toContain('data-flow="esim-install"');
    expect(page.html).toContain('for="esim-activation-code"');
    expect(page.html).toContain("Activation code");
    // The per-profile actions ride the command flows.
    expect(page.html).toContain('data-flow="esim-remove"');
    expect(page.html).toContain('data-flow="esim-enable"');
    expect(page.html).toContain("Disable this profile");
    expect(page.html).toContain("Enable this profile");
    // The way back to the device page.
    expect(page.html).toContain(`href="/devices/${PHONE_ID}"`);
  });
});

describe("blocked actions render the closed guidance map, never a mystery (§9)", () => {
  it("the macOS device renders unavailable gates with manual guidance and no forms", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: LAPTOP_ID } });
    // All three rows deny with the closed reason.
    expect(page.html).toContain('data-esim-gate="deny"');
    expect(page.html).toContain("capability-unavailable");
    // The closed guidance map renders for every blocked capability.
    expect(page.html).toContain('data-esim-guidance="true"');
    expect(page.html).toContain("When the platform cannot do it for you");
    expect(page.html).toContain(
      "The platform reports esim profile install as unavailable on this device",
    );
    expect(page.html).toContain(
      "The platform reports esim profile remove as unavailable on this device",
    );
    expect(page.html).toContain(
      "The platform reports esim profile enable as unavailable on this device",
    );
    // No action form exists on the blocked surface — and no disabled mystery.
    expect(page.html).not.toContain('data-flow="esim-install"');
    expect(page.html).not.toContain('data-flow="esim-remove"');
    expect(page.html).not.toContain('data-flow="esim-enable"');
    expect(page.html).toContain('data-esim-install="blocked"');
    expect(page.html).toContain('data-esim-profiles-empty="true"');
  });

  it("a requires-permission gate degrades with the permission guidance", async () => {
    const { app } = buildApp({
      seed: phoneCapabilitiesOverride({ esim_profile_enable: "requires-permission" }),
    });
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-esim-gate="degrade"');
    expect(page.html).toContain("capability-requires-permission");
    expect(page.html).toContain(
      "Grant the esim profile enable permission in this device",
    );
    expect(page.html).toContain(
      "RoamLink never bypasses a platform permission",
    );
    // The enable/disable action is gone (blocked, guided) but install/remove remain.
    expect(page.html).not.toContain('data-flow="esim-enable"');
    expect(page.html).toContain('data-flow="esim-install"');
    expect(page.html).toContain('data-flow="esim-remove"');
  });
});

describe("install: activation code, gated admission, honest pending state", () => {
  it("requires the activation code when the platform contract demands one", async () => {
    const { app } = buildApp();
    const missing = await app.installEsimProfileFlow(
      { deviceId: PHONE_ID, activationCode: "" },
      { idempotencyKey: "esim-install-empty" },
    );
    expect(missing.status).toBe("error");
    // The install form declares the requirement.
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain("The activation code comes from your carrier or provider");
  });

  it("a requested install is never an installed profile (truthfulness)", async () => {
    const { app, fake } = buildApp();
    const installed = await app.installEsimProfileFlow(
      { deviceId: PHONE_ID, activationCode: "LPA:1$example.test$FAKECODE" },
      { idempotencyKey: "esim-install-1" },
    );
    expect(installed.status).toBe("ok");
    if (installed.status !== "ok") return;
    const commandId = installed.acknowledgement.commandId;
    const profileId = installed.acknowledgement.resource?.id ?? "";

    // The fresh read carries the commanded state — with its pending command,
    // NOT a platform confirmation.
    const pending = await app.client().getDeviceSim(PHONE_ID);
    const profile = pending.profiles.find((p) => p.profileId === profileId);
    expect(profile?.state).toBe("install-requested");
    expect(profile?.evidenceClass).toBeNull();
    expect(profile?.freshness).toBeNull();
    expect(profile?.pending?.kind).toBe("install");
    expect(profile?.pending?.commandId).toBe(commandId);

    // The page renders the honest pending language and the unconfirmed note.
    const page = await app.renderPage({
      page: "deviceSim",
      params: { deviceId: PHONE_ID, commandId },
    });
    expect(page.html).toContain(`data-esim-profile-state="install-requested"`);
    expect(page.html).toContain("Install requested — waiting for the device to confirm");
    expect(page.html).toContain('data-esim-unconfirmed="true"');
    expect(page.html).toContain("No platform confirmation yet");
    expect(page.html).toContain("A requested change is not a completed change");
    // No new action is offered while the change is outstanding.
    expect(page.html).toContain("no new action until it settles");

    // The command pipeline: accepted + executed reached; delivered never
    // claimed for a device command (its confirmation is profile evidence,
    // not a pipeline stage).
    expect(page.html).toContain('data-esim-command-pipeline="true"');
    expect(page.html).toContain('data-stage="accepted" data-reached="true"');
    expect(page.html).toContain('data-stage="executed" data-reached="true"');
    expect(page.html).toContain('data-stage="delivered" data-reached="false"');
    expect(page.html).toContain('data-stage="billable-final" data-reached="false"');

    // Platform confirmation arrives: the profile flips to the evidenced
    // confirmed state — and ONLY then.
    expect(fake.controls.confirmEsimProfile({ deviceId: PHONE_ID, profileId })).toBe(true);
    const confirmed = await app.client().getDeviceSim(PHONE_ID);
    const confirmedProfile = confirmed.profiles.find((p) => p.profileId === profileId);
    expect(confirmedProfile?.state).toBe("enabled");
    expect(confirmedProfile?.evidenceClass).toBe("OBSERVED");
    expect(confirmedProfile?.freshness?.freshnessState).toBe("FRESH");
    expect(confirmedProfile?.pending).toBeNull();
    const confirmedPage = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(confirmedPage.html).toContain("Installed and enabled");
    expect(confirmedPage.html).toContain("Platform evidence: OBSERVED");
  });

  it("replaying the same idempotency key replays the acknowledgement (no duplicate profile)", async () => {
    const { app } = buildApp();
    const first = await app.installEsimProfileFlow(
      { deviceId: PHONE_ID, activationCode: "LPA:1$example.test$FAKECODE" },
      { idempotencyKey: "esim-install-replay" },
    );
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const replay = await app.installEsimProfileFlow(
      { deviceId: PHONE_ID, activationCode: "LPA:1$example.test$FAKECODE" },
      { idempotencyKey: "esim-install-replay" },
    );
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.acknowledgement.commandId).toBe(first.acknowledgement.commandId);
    const sim = await app.client().getDeviceSim(PHONE_ID);
    expect(sim.profiles).toHaveLength(3); // two seeded + ONE requested install
  });
});

describe("remove and enable/disable ride the same gated command envelope", () => {
  it("remove requests the removal and the confirmation removes it from the inventory", async () => {
    const { app, fake } = buildApp();
    const removed = await app.removeEsimProfileFlow(
      { deviceId: PHONE_ID, profileId: SEEDED_ENABLED_PROFILE },
      { idempotencyKey: "esim-remove-1" },
    );
    expect(removed.status).toBe("ok");
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain(`data-esim-profile-state="remove-requested"`);
    expect(page.html).toContain("Removal requested — waiting for the device to confirm");
    expect(fake.controls.confirmEsimProfile({
      deviceId: PHONE_ID,
      profileId: SEEDED_ENABLED_PROFILE,
    })).toBe(true);
    const after = await app.client().getDeviceSim(PHONE_ID);
    expect(after.profiles.find((p) => p.profileId === SEEDED_ENABLED_PROFILE)).toBeUndefined();
  });

  it("disable is requested, then confirmed with platform evidence", async () => {
    const { app, fake } = buildApp();
    const disabled = await app.enableEsimProfileFlow(
      { deviceId: PHONE_ID, profileId: SEEDED_ENABLED_PROFILE, enabled: false },
      { idempotencyKey: "esim-disable-1" },
    );
    expect(disabled.status).toBe("ok");
    if (disabled.status !== "ok") return;
    // The confirmed state stays enabled until the platform confirms.
    const pending = await app.client().getDeviceSim(PHONE_ID);
    const profile = pending.profiles.find((p) => p.profileId === SEEDED_ENABLED_PROFILE);
    expect(profile?.state).toBe("enabled");
    expect(profile?.pending?.kind).toBe("disable");
    expect(fake.controls.confirmEsimProfile({
      deviceId: PHONE_ID,
      profileId: SEEDED_ENABLED_PROFILE,
    })).toBe(true);
    const after = await app.client().getDeviceSim(PHONE_ID);
    const flipped = after.profiles.find((p) => p.profileId === SEEDED_ENABLED_PROFILE);
    expect(flipped?.state).toBe("disabled");
    expect(flipped?.evidenceClass).toBe("OBSERVED");
    expect(flipped?.freshness?.freshnessState).toBe("FRESH");
  });

  it("enabling a requested-but-unconfirmed profile is a typed conflict (never a silent pass)", async () => {
    const { app } = buildApp();
    const installed = await app.installEsimProfileFlow(
      { deviceId: PHONE_ID, activationCode: "LPA:1$example.test$FAKECODE" },
      { idempotencyKey: "esim-install-notconf" },
    );
    expect(installed.status).toBe("ok");
    if (installed.status !== "ok") return;
    const profileId = installed.acknowledgement.resource?.id ?? "";
    const result = await app.enableEsimProfileFlow(
      { deviceId: PHONE_ID, profileId, enabled: true },
      { idempotencyKey: "esim-enable-notconf" },
    );
    expect(result.status).toBe("error");
  });
});

describe("the gate blocks un-gated mutations server-side (typed, never an effect)", () => {
  it("an install against the unavailable-capability device fails closed", async () => {
    const { app } = buildApp();
    const result = await app.installEsimProfileFlow(
      { deviceId: LAPTOP_ID, activationCode: "LPA:1$example.test$FAKECODE" },
      { idempotencyKey: "esim-install-laptop" },
    );
    expect(result.status).toBe("error");
    // The typed error renders with the closed reason (and the support escape).
    const page = await app.renderPage({
      page: "deviceSim",
      params: { deviceId: LAPTOP_ID },
      lastResult: result,
    });
    expect(page.html).toContain('data-error-kind="domain"');
    expect(page.html).toContain("CAPABILITY_GATE_BLOCKED");
    expect(page.html).toContain("capability-unavailable");
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("An eSIM profile action on my device failed");
    // No profile was created (never an effect).
    const sim = await app.client().getDeviceSim(LAPTOP_ID);
    expect(sim.profiles).toHaveLength(0);
  });

  it("a stale capability evidence row blocks the gate with evidence-stale", async () => {
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-esim-gate="deny"');
    expect(page.html).toContain("evidence-stale");
    // Degraded capability evidence carries the contextual support escape.
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("capability evidence is stale or missing");
    // The stale world offers no install form (blocked, guided).
    expect(page.html).not.toContain('data-flow="esim-install"');
    expect(page.html).toContain('data-esim-install="blocked"');
  });
});

describe("fail-closed + language discipline", () => {
  it("a failing SIM read renders the typed error panel only", async () => {
    const { app } = buildApp({
      transport: {
        async request(request): Promise<HttpResponse> {
          if (request.path === `/v1/devices/${PHONE_ID}/sim`) {
            return {
              status: 503,
              body: JSON.stringify({
                kind: "unavailable",
                reason: "ESIM_READ_UNAVAILABLE",
                message: "the SIM read is temporarily unavailable",
                retryable: true,
                details: [],
              }),
            };
          }
          throw new Error("unreachable");
        },
      },
    });
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-sim-profiles-page="true"');
  });

  it("keeps internal architecture vocabulary off the journey", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "deviceSim", params: { deviceId: PHONE_ID } });
    for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
      expect(page.html).not.toContain(term);
    }
  });

  it("an unknown device renders the typed not-found panel", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({
      page: "deviceSim",
      params: { deviceId: "eeeeeeee-0000-4000-8000-0000000000ff" },
    });
    expect(page.html).toContain('data-error-kind="not-found"');
  });
});
