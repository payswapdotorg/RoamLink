/**
 * First-run onboarding journey tests (RL-082).
 *
 * Drives the REQUIRED journey (tech-lead handoff §6):
 *   land -> understand -> choose goal -> enroll device ->
 *   confirm preferences -> reach Home
 * through the REAL app against the deterministic in-memory fake, plus the
 * hard vocabulary ban: the onboarding must NEVER surface ADCOS,
 * ConnectivityIntent, reservations, NetworkPath, provider adapters, leases
 * or routing to the customer (spec/ux-architecture.md §5).
 */
import { describe, expect, it } from "vitest";
import {
  ApiClientError,
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeTenantSeed,
  type MutationFlowResult,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";
import { GOAL_CHOICES } from "../src/pages/onboarding-page.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";

/**
 * The forbidden novice-path vocabulary. The onboarding surfaces (and their
 * shell) must never render these terms; technical vocabulary stays behind
 * progressive disclosure on advanced surfaces only.
 */
const FORBIDDEN_ONBOARDING_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "ExperienceIntent",
  "NetworkPath",
  "reservation",
  "lease",
  "provider adapter",
  "routing",
  "webhook",
  "idempotency",
];

/**
 * A brand-new customer: no goals, no devices, no notifications, no commerce
 * references — the honest empty world the first-run journey starts from.
 */
function freshCustomerSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  tenants[TENANT] = {
    ...tenant,
    devices: [],
    intents: [],
    notifications: [],
    orders: [],
    subscriptions: [],
    payments: [],
    invoices: [],
    references: [],
  };
  return { ...seed, tenants };
}

function buildApp(options?: { readonly freshCustomer?: boolean }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(
    options?.freshCustomer ? freshCustomerSeed() : fakeApiSeed(),
    {
      now: () => clock.now(),
      ids: () => fakeIds.next(),
    },
  );
  const client = new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

function expectNoForbiddenVocabulary(document: string): void {
  for (const term of FORBIDDEN_ONBOARDING_VOCABULARY) {
    expect(document.toLowerCase(), `forbidden term '${term}' leaked into onboarding`).not.toContain(
      term.toLowerCase(),
    );
  }
}

describe("onboarding journey (land -> understand -> choose -> enroll -> confirm -> Home)", () => {
  it("completes the full four-step journey and lands on Home with the goal active", async () => {
    const { app, client } = buildApp({ freshCustomer: true });

    // 1. LAND: a new customer lands on the onboarding welcome.
    const land = await app.renderDocument({ page: "onboarding" });
    expect(land).toContain('data-onboarding-step="welcome"');
    expect(land).toContain("Welcome to RoamLink");
    expect(land).toContain("Get started");
    expectNoForbiddenVocabulary(land);

    // 2. UNDERSTAND -> CHOOSE: step 2 presents the spec's goal language.
    const choose = await app.renderDocument({ page: "onboarding", params: { step: "goal" } });
    expect(choose).toContain('data-onboarding-step="goal"');
    expect(choose).toContain("What do you want your connectivity to do for you?");
    for (const goal of GOAL_CHOICES) {
      expect(choose).toContain(goal.statement);
    }
    expectNoForbiddenVocabulary(choose);

    // 3. ENROLL DEVICE: step 3 offers the new-device form (fresh world:
    //    nothing enrolled yet).
    const device = await app.renderDocument({
      page: "onboarding",
      params: { step: "device", goal: "travel" },
    });
    expect(device).toContain('data-onboarding-step="device"');
    expect(device).toContain("Add a new device");
    expect(device).toContain('data-onboarding-form="enroll-device"');
    expectNoForbiddenVocabulary(device);

    // The enrollment itself is a real RoamLink command through the envelope.
    const enrolled = await app.enrollDeviceFlow(
      { name: "Travel laptop", platform: "macos" },
      { idempotencyKey: "onboarding-device-1" },
    );
    expect(enrolled.status).toBe("ok");
    const devices = await client.listDevices();
    const newDevice = devices.find((d) => d.name === "Travel laptop");
    expect(newDevice?.status).toBe("enrolled");

    // 4. CONFIRM PREFERENCES: goal + device summary in plain language.
    const confirm = await app.renderDocument({
      page: "onboarding",
      params: { step: "preferences", goal: "travel", deviceId: newDevice?.deviceId ?? "" },
    });
    expect(confirm).toContain('data-onboarding-step="preferences"');
    expect(confirm).toContain("Stay connected while traveling");
    expect(confirm).toContain("Travel laptop");
    expect(confirm).toContain('data-onboarding-form="finish"');
    expectNoForbiddenVocabulary(confirm);

    // FINISH: the flow creates the goal from the human statement and
    // activates it - both through the full command envelope.
    const finished = await app.completeOnboardingFlow(
      { deviceId: newDevice?.deviceId ?? "", goalChoiceId: "travel" },
      { idempotencyKey: "onboarding-finish-1" },
    );
    expect(finished.status).toBe("ok");

    // REACH HOME: Home renders with the customer's goal.
    const home = await app.renderDocument({ page: "home" });
    expect(home).toContain('data-home-hero="true"');
    expect(home).toContain("Stay connected while traveling");

    // The goal exists exactly once, active, bound to the chosen device.
    const intents = await client.listExperienceIntents();
    const created = intents.find((i) => i.deviceId === newDevice?.deviceId);
    expect(created?.status).toBe("active");
    expect(created?.versions).toHaveLength(1);
    expect(created?.versions[0]?.rationale).toBe("Stay connected while traveling");
    expect(created?.versions[0]?.accessClasses).toEqual(["any_internet"]);
  });

  it("step 3 offers picking an EXISTING device and the journey finishes without enrolling twice", async () => {
    const { app, client } = buildApp();
    const confirm = await app.renderDocument({
      page: "onboarding",
      params: { step: "preferences", goal: "work", deviceId: PHONE_ID },
    });
    expect(confirm).toContain("Keep work reliable");
    expect(confirm).toContain("Phone");

    const finished = await app.completeOnboardingFlow(
      { deviceId: PHONE_ID, goalChoiceId: "work" },
      { idempotencyKey: "onboarding-finish-2" },
    );
    expect(finished.status).toBe("ok");
    const intents = await client.listExperienceIntents();
    const created = intents.find(
      (i) => i.deviceId === PHONE_ID && i.versions[0]?.rationale === "Keep work reliable",
    );
    expect(created?.status).toBe("active");
    expect(created?.versions[0]?.accessClasses).toEqual(["work_apps_only"]);
  });

  it("every goal choice maps to its documented access classes", async () => {
    expect(GOAL_CHOICES.map((g) => g.id)).toEqual([
      "travel",
      "work",
      "cost",
      "trusted-wifi",
      "privacy",
      "automatic-recovery",
    ]);
    expect(GOAL_CHOICES.map((g) => g.accessClasses)).toEqual([
      ["any_internet"],
      ["work_apps_only"],
      ["metered_cost_cap"],
      ["any_internet", "metered_cost_cap"],
      ["privacy_first"],
      ["any_internet"],
    ]);
    const { app, client } = buildApp();
    // Spot-check the privacy goal end to end (create + activate only).
    const devices = await client.listDevices();
    const deviceId = devices[0]?.deviceId ?? "";
    const result = await app.completeOnboardingFlow(
      { deviceId, goalChoiceId: "privacy" },
      { idempotencyKey: "onboarding-finish-3" },
    );
    expect(result.status).toBe("ok");
    const intents = await client.listExperienceIntents();
    const created = intents.find(
      (i) => i.deviceId === deviceId && i.versions[0]?.rationale === "Protect privacy",
    );
    expect(created?.versions[0]?.accessClasses).toEqual(["privacy_first"]);
  });

  it("an unknown goal choice fails with the typed validation error (no invented state)", async () => {
    const { app, client } = buildApp();
    const result = await app.completeOnboardingFlow(
      { deviceId: PHONE_ID, goalChoiceId: "does-not-exist" },
      { idempotencyKey: "onboarding-finish-bad" },
    );
    expect(result.status).toBe("error");
    const rendered = await app.renderPage({ page: "onboarding", params: { step: "preferences" }, lastResult: result });
    expect(rendered.html).toContain('data-mutation-result="error"');
    const intents = await client.listExperienceIntents();
    expect(intents.find((i) => i.versions[0]?.rationale === "does-not-exist")).toBeUndefined();
  });

  it("a failed finish flow surfaces the typed error on the confirm step", async () => {
    const { app } = buildApp();
    // A device that does not exist -> the create command fails at the API.
    const result = await app.completeOnboardingFlow(
      { deviceId: "00000000-0000-4000-8000-000000000000", goalChoiceId: "travel" },
      { idempotencyKey: "onboarding-finish-missing-device" },
    );
    expect(result.status).toBe("error");
    const rendered = await app.renderPage({ page: "onboarding", params: { step: "preferences", goal: "travel" }, lastResult: result });
    expect(rendered.html).toContain('data-mutation-result="error"');
  });
});

// ---------------------------------------------------------------------------
// PA-022 — the finish flow's read-first completion + the pending-goal
// explainer (the multi-tick first attempt's honest outcome, presented with
// journey guidance instead of a bare retryable error).
// ---------------------------------------------------------------------------

describe("PA-022 onboarding finish: read-first completion (never a duplicate draft)", () => {
  it("activates a prior attempt's matching draft instead of creating another goal", async () => {
    const { app, client } = buildApp({ freshCustomer: true });
    const devices = await client.listDevices();
    expect(devices).toHaveLength(0);

    // A prior finish attempt's create, already executed as a DRAFT goal for
    // the "travel" choice (exactly the post-tick state the read-first leg
    // looks for — same device, same statement, still draft).
    const enrolled = await app.enrollDeviceFlow(
      { name: "Retry Phone", platform: "ios" },
      { idempotencyKey: "pa022-retry-enroll" },
    );
    expect(enrolled.status).toBe("ok");
    const device = (await client.listDevices()).find((d) => d.name === "Retry Phone");
    expect(device).toBeDefined();
    const created = await app.createIntentFlow(
      {
        deviceId: device?.deviceId ?? "",
        rationale: "Stay connected while traveling",
        accessClasses: ["any_internet"],
      },
      { idempotencyKey: "pa022-prior-create" },
    );
    expect(created.status).toBe("ok");

    // The RETRY (a fresh idempotency key, exactly what a hosted form POST
    // carries): the flow must find and ACTIVATE the existing draft — no
    // second goal is created.
    const retry = await app.completeOnboardingFlow(
      { deviceId: device?.deviceId ?? "", goalChoiceId: "travel" },
      { idempotencyKey: "pa022-finish-retry-fresh-key" },
    );
    expect(retry.status).toBe("ok");

    const intents = await client.listExperienceIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe("active");
    expect(intents[0]?.versions).toHaveLength(1);
    expect(intents[0]?.versions[0]?.rationale).toBe("Stay connected while traveling");
  });

  it("does not adopt a draft with a DIFFERENT statement (a distinct goal is a distinct goal)", async () => {
    const { app, client } = buildApp({ freshCustomer: true });
    const enrolled = await app.enrollDeviceFlow(
      { name: "Other Phone", platform: "android" },
      { idempotencyKey: "pa022-other-enroll" },
    );
    expect(enrolled.status).toBe("ok");
    const device = (await client.listDevices()).find((d) => d.name === "Other Phone");
    const created = await app.createIntentFlow(
      {
        deviceId: device?.deviceId ?? "",
        rationale: "Keep work reliable",
        accessClasses: ["work_apps_only"],
      },
      { idempotencyKey: "pa022-other-create" },
    );
    expect(created.status).toBe("ok");

    // Finishing with the TRAVEL choice: the work-reliability draft is NOT a
    // match, so the flow creates the customer's chosen goal separately.
    const finished = await app.completeOnboardingFlow(
      { deviceId: device?.deviceId ?? "", goalChoiceId: "travel" },
      { idempotencyKey: "pa022-other-finish" },
    );
    expect(finished.status).toBe("ok");
    const intents = await client.listExperienceIntents();
    expect(intents).toHaveLength(2);
    const travel = intents.find((i) => i.status === "active");
    expect(travel?.versions[0]?.rationale).toBe("Stay connected while traveling");
    const workDraft = intents.find((i) => i.status === "draft");
    expect(workDraft?.versions[0]?.rationale).toBe("Keep work reliable");
  });
});

describe("PA-022 onboarding preferences: the pending-goal explainer", () => {
  /** The typed error the honest multi-tick first attempt returns. */
  function pendingGoalResult(): MutationFlowResult {
    return {
      status: "error",
      error: new ApiClientError({
        kind: "unknown-state",
        reason: "ONBOARDING_GOAL_NOT_CREATED",
        message: "the created goal id was not returned; the goal cannot be activated safely",
        retryable: true,
        status: 0,
      }),
    };
  }

  it("renders the calm explainer under the honest typed error for the retryable pending state", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({
      page: "onboarding",
      params: { step: "preferences", goal: "travel", deviceId: PHONE_ID },
      lastResult: pendingGoalResult(),
    });
    // The honest typed error panel still renders first...
    expect(document).toContain('data-mutation-result="error"');
    expect(document).toContain("ONBOARDING_GOAL_NOT_CREATED");
    // ...and the preferences step adds the journey-scoped explainer.
    expect(document).toContain('data-onboarding-pending-goal="true"');
    expect(document).toContain("Your goal choice is recorded");
    expect(document).toContain("Choose Finish and go to Home again in a moment");
    // The wizard stays completable: the finish form still renders.
    expect(document).toContain('data-onboarding-form="finish"');
  });

  it("renders NO explainer for other failure kinds (only the pending state is explained)", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({
      page: "onboarding",
      params: { step: "preferences", goal: "travel", deviceId: PHONE_ID },
      lastResult: {
        status: "error",
        error: new ApiClientError({
          kind: "validation",
          reason: "REQUEST_PAYLOAD_INVALID",
          message: "the onboarding goal choice does not exist",
          retryable: false,
          status: 0,
        }),
      },
    });
    expect(document).toContain('data-mutation-result="error"');
    expect(document).not.toContain('data-onboarding-pending-goal="true"');
  });

  it("renders no explainer on a clean render (nothing pending)", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({
      page: "onboarding",
      params: { step: "preferences", goal: "travel", deviceId: PHONE_ID },
    });
    expect(document).toContain('data-onboarding-form="finish"');
    expect(document).not.toContain('data-onboarding-pending-goal="true"');
  });
});
