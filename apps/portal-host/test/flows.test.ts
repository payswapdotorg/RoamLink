/**
 * The /flows/* dispatcher unit tests (PA-018).
 *
 * This suite pins the per-flow dispatcher's LAWS without booting the real
 * composition: the closed FLOW_HANDLERS union, the per-flow redirect law
 * (provision-connector → /workspace?commandId=<ack.commandId>;
 * onboarding-finish → /), the per-flow render targets (the originating
 * page for every render-after-post flow), and the form-field validation
 * laws (the typed `FormValidationError` for missing/invalid fields, the
 * typed `ApiClientError` shape `formValidationErrorOf` produces).
 *
 * The HTTP handler's transport-level laws (CSRF, session, runtime-not-
 * ready, unknown-flow) are pinned end-to-end through the form-encoded
 * round-trip battery in tests/e2e/test/hosted-flows-form-actions.test.ts;
 * this suite is the dispatcher's own contract gate.
 */
import { describe, expect, it } from "vitest";

import {
  FLOW_HANDLERS,
  WIRED_FLOW_NAMES,
  FormValidationError,
  formValidationErrorOf,
  type FlowHandler,
  type FlowRunContext,
} from "../src/flows.js";
import type { CustomerWebApp } from "@roamlink/web";
import type { MutationAcknowledgement } from "@roamlink/app-kit";

// ---------------------------------------------------------------------------
// The closed flow union
// ---------------------------------------------------------------------------

describe("PA-018 /flows dispatcher: the closed flow union", () => {
  it("wires every rendered form action (the F-016-1 union is closed)", () => {
    const expected = [
      "enroll-device",
      "update-device",
      "retire-device",
      "esim-install",
      "esim-enable",
      "esim-remove",
      "mark-notification-read",
      "create-intent",
      "activate-intent",
      "supersede-intent",
      "create-support-case",
      "place-order",
      "record-payment",
      "cancel-order",
      "provision-connector",
      "onboarding-enroll-device",
      "onboarding-finish",
    ].sort();
    expect([...WIRED_FLOW_NAMES].sort()).toEqual(expected);
    // Every wired name resolves to a handler.
    for (const name of WIRED_FLOW_NAMES) {
      expect(FLOW_HANDLERS[name]).toBeDefined();
      expect(FLOW_HANDLERS[name]?.name).toBe(name);
    }
  });

  it("the FLOW_HANDLERS table is frozen (no mutation through the surface)", () => {
    expect(Object.isFrozen(FLOW_HANDLERS)).toBe(true);
    expect(Object.isFrozen(WIRED_FLOW_NAMES)).toBe(true);
  });

  it("no two handlers share a render path conflict (every flow has a deterministic response shape)", () => {
    for (const name of WIRED_FLOW_NAMES) {
      const handler = FLOW_HANDLERS[name];
      if (handler === undefined) continue;
      // Every handler has EITHER a renderPath OR a redirectOnSuccess (most
      // have both — the redirect law fires on success, the render law on
      // failure). A handler with NEITHER would produce the internal-error
      // 500, which is never the form's contract.
      expect(handler.renderPath !== undefined || handler.redirectOnSuccess !== undefined).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The redirect laws (the explicit README contracts)
// ---------------------------------------------------------------------------

describe("PA-018 /flows dispatcher: the redirect laws", () => {
  it("provision-connector redirects to /workspace?commandId=<ack.commandId> on success", () => {
    const handler = FLOW_HANDLERS["provision-connector"];
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    expect(handler.redirectOnSuccess).toBeDefined();
    const form = new FormData();
    form.set("connectorId", "demo-connector");
    const ack: MutationAcknowledgement = {
      commandId: "cmd-018-connector" as never,
      correlationId: "corr-018" as never,
      idempotencyKey: "idem-018" as never,
      acceptedAt: "2026-09-25T00:00:00.000Z",
    };
    const target = handler.redirectOnSuccess?.(form, ack);
    expect(target).toBe("/workspace?commandId=cmd-018-connector");
  });

  it("onboarding-finish redirects to / (Home) on success", () => {
    const handler = FLOW_HANDLERS["onboarding-finish"];
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    expect(handler.redirectOnSuccess).toBeDefined();
    const form = new FormData();
    form.set("goal", "travel");
    form.set("deviceId", "0f0f0f0f-0000-4000-8000-0000000000e1");
    const ack: MutationAcknowledgement = {
      commandId: "cmd-018-finish" as never,
      correlationId: "corr-018" as never,
      idempotencyKey: "idem-018" as never,
      acceptedAt: "2026-09-25T00:00:00.000Z",
    };
    const target = handler.redirectOnSuccess?.(form, ack);
    expect(target).toBe("/");
  });

  it("no other flow has a redirect law (every other flow re-renders the originating page)", () => {
    const redirectFlows = new Set(["provision-connector", "onboarding-finish"]);
    for (const name of WIRED_FLOW_NAMES) {
      if (redirectFlows.has(name)) continue;
      const handler = FLOW_HANDLERS[name];
      if (handler === undefined) continue;
      expect(handler.redirectOnSuccess, `${name} should NOT have a redirect law`).toBeUndefined();
      expect(handler.renderPath, `${name} should have a render path`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The render-path laws (the originating page is the page that hosts the form)
// ---------------------------------------------------------------------------

describe("PA-018 /flows dispatcher: the render-path laws", () => {
  it("enroll-device renders /devices", () => {
    const handler = FLOW_HANDLERS["enroll-device"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("enroll-device missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/devices" });
  });

  it("update-device renders /devices/<deviceId>", () => {
    const handler = FLOW_HANDLERS["update-device"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("update-device missing renderPath");
    const form = new FormData();
    form.set("deviceId", "dev-123");
    expect(handler.renderPath(form)).toEqual({ pathname: "/devices/dev-123" });
  });

  it("retire-device renders /devices/<deviceId>", () => {
    const handler = FLOW_HANDLERS["retire-device"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("retire-device missing renderPath");
    const form = new FormData();
    form.set("deviceId", "dev-456");
    expect(handler.renderPath(form)).toEqual({ pathname: "/devices/dev-456" });
  });

  it("esim-install renders /devices/<deviceId>/sim (the single-placeholder-with-suffix route)", () => {
    const handler = FLOW_HANDLERS["esim-install"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("esim-install missing renderPath");
    const form = new FormData();
    form.set("deviceId", "dev-sim");
    expect(handler.renderPath(form)).toEqual({ pathname: "/devices/dev-sim/sim" });
  });

  it("esim-enable renders /devices/<deviceId>/sim", () => {
    const handler = FLOW_HANDLERS["esim-enable"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("esim-enable missing renderPath");
    const form = new FormData();
    form.set("deviceId", "dev-7");
    form.set("profileId", "prof-1");
    form.set("enabled", "true");
    expect(handler.renderPath(form)).toEqual({ pathname: "/devices/dev-7/sim" });
  });

  it("esim-remove renders /devices/<deviceId>/sim", () => {
    const handler = FLOW_HANDLERS["esim-remove"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("esim-remove missing renderPath");
    const form = new FormData();
    form.set("deviceId", "dev-rm");
    form.set("profileId", "prof-rm");
    expect(handler.renderPath(form)).toEqual({ pathname: "/devices/dev-rm/sim" });
  });

  it("mark-notification-read renders /notifications", () => {
    const handler = FLOW_HANDLERS["mark-notification-read"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("mark-notification-read missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/notifications" });
  });

  it("create-intent renders /intents", () => {
    const handler = FLOW_HANDLERS["create-intent"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("create-intent missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/intents" });
  });

  it("activate-intent renders /intents/<intentId>", () => {
    const handler = FLOW_HANDLERS["activate-intent"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("activate-intent missing renderPath");
    const form = new FormData();
    form.set("intentId", "int-9");
    expect(handler.renderPath(form)).toEqual({ pathname: "/intents/int-9" });
  });

  it("supersede-intent renders /intents/<intentId>", () => {
    const handler = FLOW_HANDLERS["supersede-intent"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("supersede-intent missing renderPath");
    const form = new FormData();
    form.set("intentId", "int-9");
    expect(handler.renderPath(form)).toEqual({ pathname: "/intents/int-9" });
  });

  it("create-support-case renders /support", () => {
    const handler = FLOW_HANDLERS["create-support-case"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("create-support-case missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/support" });
  });

  it("place-order renders /commerce", () => {
    const handler = FLOW_HANDLERS["place-order"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("place-order missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/commerce" });
  });

  it("record-payment renders /commerce", () => {
    const handler = FLOW_HANDLERS["record-payment"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("record-payment missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/commerce" });
  });

  it("cancel-order renders /commerce", () => {
    const handler = FLOW_HANDLERS["cancel-order"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("cancel-order missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/commerce" });
  });

  it("provision-connector renders /workspace (the failure-path render target)", () => {
    const handler = FLOW_HANDLERS["provision-connector"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("provision-connector missing renderPath");
    expect(handler.renderPath(new FormData())).toEqual({ pathname: "/workspace" });
  });

  it("onboarding-enroll-device renders /onboarding?step=device&goal=<goal> (the wizard step retained)", () => {
    const handler = FLOW_HANDLERS["onboarding-enroll-device"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("onboarding-enroll-device missing renderPath");
    const form = new FormData();
    form.set("goal", "travel");
    const target = handler.renderPath(form);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams?.get("step")).toBe("device");
    expect(target.searchParams?.get("goal")).toBe("travel");
  });

  it("onboarding-finish renders /onboarding?step=preferences&goal=<goal>&deviceId=<deviceId> (the failure-path render target)", () => {
    const handler = FLOW_HANDLERS["onboarding-finish"];
    if (handler === undefined || handler.renderPath === undefined) throw new Error("onboarding-finish missing renderPath");
    const form = new FormData();
    form.set("goal", "travel");
    form.set("deviceId", "0f0f0f0f-0000-4000-8000-0000000000e1");
    const target = handler.renderPath(form);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams?.get("step")).toBe("preferences");
    expect(target.searchParams?.get("goal")).toBe("travel");
    expect(target.searchParams?.get("deviceId")).toBe("0f0f0f0f-0000-4000-8000-0000000000e1");
  });
});

// ---------------------------------------------------------------------------
// The parse laws (form-encoded → typed flow-method input, fail-closed)
// ---------------------------------------------------------------------------

describe("PA-018 /flows dispatcher: the parse laws (fail-closed form validation)", () => {
  it("enroll-device parses name + platform", () => {
    const handler = FLOW_HANDLERS["enroll-device"];
    if (handler === undefined) throw new Error("enroll-device missing");
    const form = new FormData();
    form.set("name", "Test Phone");
    form.set("platform", "ios");
    expect(handler.parse(form)).toEqual({ name: "Test Phone", platform: "ios" });
  });

  it("enroll-device rejects an invalid platform", () => {
    const handler = FLOW_HANDLERS["enroll-device"];
    if (handler === undefined) throw new Error("enroll-device missing");
    const form = new FormData();
    form.set("name", "X");
    form.set("platform", "windows-phone");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("enroll-device rejects a missing name", () => {
    const handler = FLOW_HANDLERS["enroll-device"];
    if (handler === undefined) throw new Error("enroll-device missing");
    const form = new FormData();
    form.set("platform", "ios");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("update-device parses deviceId + optional name (omitted name → undefined)", () => {
    const handler = FLOW_HANDLERS["update-device"];
    if (handler === undefined) throw new Error("update-device missing");
    const form = new FormData();
    form.set("deviceId", "dev-1");
    expect(handler.parse(form)).toEqual({ deviceId: "dev-1" });
  });

  it("retire-device parses deviceId only", () => {
    const handler = FLOW_HANDLERS["retire-device"];
    if (handler === undefined) throw new Error("retire-device missing");
    const form = new FormData();
    form.set("deviceId", "dev-2");
    expect(handler.parse(form)).toEqual({ deviceId: "dev-2" });
  });

  it("esim-install requires an activationCode (fail-closed — the typed API requires a non-empty string)", () => {
    const handler = FLOW_HANDLERS["esim-install"];
    if (handler === undefined) throw new Error("esim-install missing");
    const form = new FormData();
    form.set("deviceId", "dev-3");
    // No activationCode — the host fails closed at the seam.
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("esim-enable parses enabled as a boolean", () => {
    const handler = FLOW_HANDLERS["esim-enable"];
    if (handler === undefined) throw new Error("esim-enable missing");
    const form = new FormData();
    form.set("deviceId", "dev-4");
    form.set("profileId", "prof-1");
    form.set("enabled", "false");
    expect(handler.parse(form)).toEqual({ deviceId: "dev-4", profileId: "prof-1", enabled: false });
  });

  it("esim-enable rejects an invalid enabled value", () => {
    const handler = FLOW_HANDLERS["esim-enable"];
    if (handler === undefined) throw new Error("esim-enable missing");
    const form = new FormData();
    form.set("deviceId", "dev-4");
    form.set("profileId", "prof-1");
    form.set("enabled", "yes");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("create-intent requires a non-empty accessClasses (host-side validation, no command attempted)", () => {
    const handler = FLOW_HANDLERS["create-intent"];
    if (handler === undefined) throw new Error("create-intent missing");
    const form = new FormData();
    form.set("deviceId", "dev-5");
    form.set("rationale", "Goal");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("create-intent accepts a single accessClasses value", () => {
    const handler = FLOW_HANDLERS["create-intent"];
    if (handler === undefined) throw new Error("create-intent missing");
    const form = new FormData();
    form.set("deviceId", "dev-5");
    form.set("rationale", "Goal");
    form.append("accessClasses", "any_internet");
    expect(handler.parse(form)).toEqual({
      deviceId: "dev-5",
      rationale: "Goal",
      accessClasses: ["any_internet"],
    });
  });

  it("create-intent rejects an out-of-vocabulary accessClass", () => {
    const handler = FLOW_HANDLERS["create-intent"];
    if (handler === undefined) throw new Error("create-intent missing");
    const form = new FormData();
    form.set("deviceId", "dev-5");
    form.set("rationale", "Goal");
    form.append("accessClasses", "any_internet");
    form.append("accessClasses", "gigabit_fiber");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("supersede-intent requires accessClasses (the typed API does too — host-side validation)", () => {
    const handler = FLOW_HANDLERS["supersede-intent"];
    if (handler === undefined) throw new Error("supersede-intent missing");
    const form = new FormData();
    form.set("intentId", "int-9");
    form.set("rationale", "New");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("create-support-case parses subject/description/priority and optional relatedRefs", () => {
    const handler = FLOW_HANDLERS["create-support-case"];
    if (handler === undefined) throw new Error("create-support-case missing");
    const form = new FormData();
    form.set("subject", "Subj");
    form.set("description", "Desc");
    form.set("priority", "high");
    form.append("relatedRef", "order~ord-1");
    form.append("relatedRef", "device~dev-1");
    expect(handler.parse(form)).toEqual({
      subject: "Subj",
      description: "Desc",
      priority: "high",
      relatedRefs: [
        { kind: "order", id: "ord-1" },
        { kind: "device", id: "dev-1" },
      ],
    });
  });

  it("create-support-case rejects a malformed relatedRef (no `~` separator)", () => {
    const handler = FLOW_HANDLERS["create-support-case"];
    if (handler === undefined) throw new Error("create-support-case missing");
    const form = new FormData();
    form.set("subject", "S");
    form.set("description", "D");
    form.set("priority", "low");
    form.append("relatedRef", "no-separator");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("place-order parses variantId + quantity (integer)", () => {
    const handler = FLOW_HANDLERS["place-order"];
    if (handler === undefined) throw new Error("place-order missing");
    const form = new FormData();
    form.set("variantId", "var-1");
    form.set("quantity", "3");
    expect(handler.parse(form)).toEqual({
      lines: [{ variantId: "var-1", quantity: 3 }],
    });
  });

  it("place-order rejects a non-numeric quantity", () => {
    const handler = FLOW_HANDLERS["place-order"];
    if (handler === undefined) throw new Error("place-order missing");
    const form = new FormData();
    form.set("variantId", "var-1");
    form.set("quantity", "two");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("record-payment parses orderId + amountMinor (integer) + currency", () => {
    const handler = FLOW_HANDLERS["record-payment"];
    if (handler === undefined) throw new Error("record-payment missing");
    const form = new FormData();
    form.set("orderId", "ord-1");
    form.set("amountMinor", "2499");
    form.set("currency", "USD");
    expect(handler.parse(form)).toEqual({
      orderId: "ord-1",
      amountMinor: 2499,
      currency: "USD",
    });
  });

  it("provision-connector parses connectorId", () => {
    const handler = FLOW_HANDLERS["provision-connector"];
    if (handler === undefined) throw new Error("provision-connector missing");
    const form = new FormData();
    form.set("connectorId", "acme-hq");
    expect(handler.parse(form)).toEqual({ connectorId: "acme-hq" });
  });

  it("onboarding-enroll-device parses goal + name + platform", () => {
    const handler = FLOW_HANDLERS["onboarding-enroll-device"];
    if (handler === undefined) throw new Error("onboarding-enroll-device missing");
    const form = new FormData();
    form.set("goal", "travel");
    form.set("name", "Phone");
    form.set("platform", "ios");
    expect(handler.parse(form)).toEqual({ goal: "travel", name: "Phone", platform: "ios" });
  });

  it("onboarding-enroll-device rejects an invalid goal", () => {
    const handler = FLOW_HANDLERS["onboarding-enroll-device"];
    if (handler === undefined) throw new Error("onboarding-enroll-device missing");
    const form = new FormData();
    form.set("goal", "totally-new-goal");
    form.set("name", "X");
    form.set("platform", "ios");
    expect(() => handler.parse(form)).toThrow(FormValidationError);
  });

  it("onboarding-finish parses goal + deviceId", () => {
    const handler = FLOW_HANDLERS["onboarding-finish"];
    if (handler === undefined) throw new Error("onboarding-finish missing");
    const form = new FormData();
    form.set("goal", "work");
    form.set("deviceId", "dev-1");
    expect(handler.parse(form)).toEqual({ goalChoiceId: "work", deviceId: "dev-1" });
  });
});

// ---------------------------------------------------------------------------
// The formValidationErrorOf mapping (typed ApiClientError shape)
// ---------------------------------------------------------------------------

describe("PA-018 /flows dispatcher: the formValidationErrorOf mapping", () => {
  it("produces a typed ApiClientError with the validation kind/reason", () => {
    const error = new FormValidationError("name", "is required");
    const apiError = formValidationErrorOf(error);
    expect(apiError.kind).toBe("validation");
    expect(apiError.reason).toBe("FORM_FIELDS_INVALID");
    expect(apiError.retryable).toBe(false);
    expect(apiError.status).toBe(400);
    expect(apiError.message).toContain("name");
    expect(apiError.message).toContain("is required");
    expect(apiError.details).toContainEqual({ path: "name", issue: error.message });
  });
});

// ---------------------------------------------------------------------------
// The run laws (the dispatcher delegates to CustomerWebApp.<flow>Flow)
// ---------------------------------------------------------------------------

/**
 * A minimal fake CustomerWebApp that records the calls made to its flow
 * methods. The dispatcher's `run` step is a thin delegate; this test pins
 * that each flow calls the matching method with the parsed input + the
 * idempotency-key option.
 */
function fakeCustomerWebApp(): CustomerWebApp & {
  readonly calls: ReadonlyArray<{ readonly method: string; readonly input: unknown; readonly options: unknown }>;
} {
  const calls: { method: string; input: unknown; options: unknown }[] = [];
  const fake = {
    calls,
    enrollDeviceFlow(input: unknown, options?: unknown) {
      calls.push({ method: "enrollDeviceFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-enroll" } });
    },
    updateDeviceFlow(input: unknown, options?: unknown) {
      calls.push({ method: "updateDeviceFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-update" } });
    },
    retireDeviceFlow(input: unknown, options?: unknown) {
      calls.push({ method: "retireDeviceFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-retire" } });
    },
    installEsimProfileFlow(input: unknown, options?: unknown) {
      calls.push({ method: "installEsimProfileFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-esim-install" } });
    },
    removeEsimProfileFlow(input: unknown, options?: unknown) {
      calls.push({ method: "removeEsimProfileFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-esim-remove" } });
    },
    enableEsimProfileFlow(input: unknown, options?: unknown) {
      calls.push({ method: "enableEsimProfileFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-esim-enable" } });
    },
    markNotificationReadFlow(input: unknown, options?: unknown) {
      calls.push({ method: "markNotificationReadFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-mark" } });
    },
    createIntentFlow(input: unknown, options?: unknown) {
      calls.push({ method: "createIntentFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-create-intent" } });
    },
    activateIntentFlow(input: unknown, options?: unknown) {
      calls.push({ method: "activateIntentFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-activate" } });
    },
    supersedeIntentFlow(input: unknown, options?: unknown) {
      calls.push({ method: "supersedeIntentFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-supersede" } });
    },
    createSupportCaseFlow(input: unknown, options?: unknown) {
      calls.push({ method: "createSupportCaseFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-support" } });
    },
    placeOrderFlow(input: unknown, options?: unknown) {
      calls.push({ method: "placeOrderFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-place" } });
    },
    recordPaymentFlow(input: unknown, options?: unknown) {
      calls.push({ method: "recordPaymentFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-pay" } });
    },
    cancelOrderFlow(input: unknown, options?: unknown) {
      calls.push({ method: "cancelOrderFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-cancel" } });
    },
    provisionConnectorFlow(input: unknown, options?: unknown) {
      calls.push({ method: "provisionConnectorFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-connector" } });
    },
    completeOnboardingFlow(input: unknown, options?: unknown) {
      calls.push({ method: "completeOnboardingFlow", input, options });
      return Promise.resolve({ status: "ok", acknowledgement: { commandId: "cmd-finish" } });
    },
  } as unknown as CustomerWebApp & { readonly calls: ReadonlyArray<{ readonly method: string; readonly input: unknown; readonly options: unknown }> };
  return fake;
}

describe("PA-018 /flows dispatcher: the run laws (delegation to CustomerWebApp)", () => {
  it("every flow delegates to the matching typed flow method with the idempotency key", async () => {
    const app = fakeCustomerWebApp();
    const idempotencyKey = "test-key-018";
    const ctx: FlowRunContext = { app, idempotencyKey };

    // Run each flow with a minimal valid form.
    const cases: ReadonlyArray<{ readonly name: string; readonly form: () => FormData; readonly expectedMethod: string }> = [
      { name: "enroll-device", expectedMethod: "enrollDeviceFlow", form: () => {
        const f = new FormData(); f.set("name", "X"); f.set("platform", "ios"); return f;
      } },
      { name: "update-device", expectedMethod: "updateDeviceFlow", form: () => {
        const f = new FormData(); f.set("deviceId", "dev"); f.set("name", "Y"); return f;
      } },
      { name: "retire-device", expectedMethod: "retireDeviceFlow", form: () => {
        const f = new FormData(); f.set("deviceId", "dev"); return f;
      } },
      { name: "esim-install", expectedMethod: "installEsimProfileFlow", form: () => {
        const f = new FormData(); f.set("deviceId", "dev"); f.set("activationCode", "ac"); return f;
      } },
      { name: "esim-enable", expectedMethod: "enableEsimProfileFlow", form: () => {
        const f = new FormData(); f.set("deviceId", "dev"); f.set("profileId", "p"); f.set("enabled", "true"); return f;
      } },
      { name: "esim-remove", expectedMethod: "removeEsimProfileFlow", form: () => {
        const f = new FormData(); f.set("deviceId", "dev"); f.set("profileId", "p"); return f;
      } },
      { name: "mark-notification-read", expectedMethod: "markNotificationReadFlow", form: () => {
        const f = new FormData(); f.set("notificationId", "n"); return f;
      } },
      { name: "create-intent", expectedMethod: "createIntentFlow", form: () => {
        const f = new FormData(); f.set("deviceId", "d"); f.set("rationale", "r"); f.append("accessClasses", "any_internet"); return f;
      } },
      { name: "activate-intent", expectedMethod: "activateIntentFlow", form: () => {
        const f = new FormData(); f.set("intentId", "i"); return f;
      } },
      { name: "supersede-intent", expectedMethod: "supersedeIntentFlow", form: () => {
        const f = new FormData(); f.set("intentId", "i"); f.set("rationale", "r"); f.append("accessClasses", "any_internet"); return f;
      } },
      { name: "create-support-case", expectedMethod: "createSupportCaseFlow", form: () => {
        const f = new FormData(); f.set("subject", "s"); f.set("description", "d"); f.set("priority", "low"); return f;
      } },
      { name: "place-order", expectedMethod: "placeOrderFlow", form: () => {
        const f = new FormData(); f.set("variantId", "v"); f.set("quantity", "1"); return f;
      } },
      { name: "record-payment", expectedMethod: "recordPaymentFlow", form: () => {
        const f = new FormData(); f.set("orderId", "o"); f.set("amountMinor", "1"); f.set("currency", "USD"); return f;
      } },
      { name: "cancel-order", expectedMethod: "cancelOrderFlow", form: () => {
        const f = new FormData(); f.set("orderId", "o"); return f;
      } },
      { name: "provision-connector", expectedMethod: "provisionConnectorFlow", form: () => {
        const f = new FormData(); f.set("connectorId", "c"); return f;
      } },
      { name: "onboarding-enroll-device", expectedMethod: "enrollDeviceFlow", form: () => {
        const f = new FormData(); f.set("goal", "travel"); f.set("name", "n"); f.set("platform", "ios"); return f;
      } },
      { name: "onboarding-finish", expectedMethod: "completeOnboardingFlow", form: () => {
        const f = new FormData(); f.set("goal", "travel"); f.set("deviceId", "d"); return f;
      } },
    ];

    for (const testCase of cases) {
      const handler: FlowHandler | undefined = FLOW_HANDLERS[testCase.name];
      if (handler === undefined) throw new Error(`${testCase.name} missing from FLOW_HANDLERS`);
      const form = testCase.form();
      const input = handler.parse(form);
      const result = await handler.run(ctx, input);
      expect(result.status, `${testCase.name} should return ok`).toBe("ok");
      const lastCall = app.calls[app.calls.length - 1];
      expect(lastCall?.method, `${testCase.name} should call ${testCase.expectedMethod}`).toBe(testCase.expectedMethod);
      expect(lastCall?.options, `${testCase.name} should pass the idempotency key`).toMatchObject({ idempotencyKey });
    }
  });
});
