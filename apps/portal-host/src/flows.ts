/**
 * The /flows/* form-action dispatcher (PA-018 — closes F-016-1).
 *
 * The portal host owns the wiring of the rendered `/flows/*` form actions to
 * the matching typed flow methods on `CustomerWebApp` (apps/web README.md
 * "Mounting": "a host … wires the rendered form actions (`/flows/*`,
 * `data-flow` attributes) to the matching flow methods. The host owns
 * sessions/CSRF"). This module is the host's per-flow table: a closed mapping
 * from each rendered form action to its (parse, run, renderOrRedirect)
 * triple. The HTTP handler in `handlers.ts` (`handleFlowSubmit`) owns the
 * transport: runtime gate, flow lookup, CSRF (same-origin), session
 * resolution, form-encoded parsing, dispatch, and the response shape per the
 * page contracts.
 *
 * Fail-closed laws (the host never invents success):
 *   - parse throws `FormValidationError` for missing/invalid fields → the
 *     handler renders the originating page with the typed validation error;
 *   - run returns the typed `MutationFlowResult` (the app's flow methods
 *     already wrap the typed `ApiClientError` on every failure);
 *   - the redirect law for the connector enrollment
 *     (`/workspace?commandId=<ack.commandId>`) and the onboarding-finish law
 *     (redirect to `/`) are honored exactly; every other flow re-renders
 *     the originating page with the `lastResult` panel above the body.
 *
 * No new runtime dependencies. The host adds NO authority of its own: every
 * command flows through the typed `CustomerWebApp` flow methods, the app
 * never sees credentials (RL-LOCK-016).
 */
import { ApiClientError, type MutationAcknowledgement, type MutationFlowResult } from "@roamlink/app-kit";
import type { CustomerWebApp } from "@roamlink/web";

// ---------------------------------------------------------------------------
// Closed vocabularies (mirrors of the app's rendered form vocabularies —
// kept local to the dispatcher; the app remains the single source of truth
// for the rendered option lists, and the typed flow methods remain the
// single source of truth for the accepted values).
// ---------------------------------------------------------------------------

const DEVICE_PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "embedded",
  "other",
] as const;
type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

const INTENT_ACCESS_CLASSES = [
  "any_internet",
  "work_apps_only",
  "streaming",
  "low_power",
  "metered_cost_cap",
  "privacy_first",
  "regional_compliance",
] as const;
type IntentAccessClass = (typeof INTENT_ACCESS_CLASSES)[number];

const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

const ONBOARDING_GOAL_CHOICES = [
  "travel",
  "work",
  "cost",
  "trusted-wifi",
  "privacy",
  "automatic-recovery",
] as const;
type OnboardingGoalChoice = (typeof ONBOARDING_GOAL_CHOICES)[number];

// ---------------------------------------------------------------------------
// Fail-closed form helpers
// ---------------------------------------------------------------------------

/**
 * The typed host-side validation failure (one malformed form field). The
 * handler turns this into a typed `ApiClientError` (kind: validation) so the
 * page renders the standard mutation-result error panel above the body —
 * never a raw third-party string (RL-LOCK-016).
 */
export class FormValidationError extends Error {
  readonly field: string;
  constructor(field: string, issue: string) {
    super(`the form field "${field}" ${issue}`);
    this.name = "FormValidationError";
    this.field = field;
  }
}

/** Reads a required non-empty string field, fail-closed on missing/empty. */
function requiredString(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || value.length === 0) {
    throw new FormValidationError(field, "is required (a non-empty string)");
  }
  return value;
}

/**
 * Reads an optional string field (the rendered form may omit it — e.g. the
 * eSIM install `activationCode` is only rendered when the platform requires
 * one). Missing returns undefined; present must be a string (any length —
 * the typed flow method's own validation is the contract authority).
 */
function optionalString(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new FormValidationError(field, "must be a string when present");
  }
  return value;
}

/** Reads a required integer field, fail-closed on missing/non-numeric. */
function requiredInteger(form: FormData, field: string): number {
  const raw = form.get(field);
  if (typeof raw !== "string" || raw.length === 0) {
    throw new FormValidationError(field, "is required (an integer)");
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FormValidationError(field, "must be a non-negative integer");
  }
  return parsed;
}

/** Reads a required boolean field encoded as the strings "true"/"false". */
function requiredBoolean(form: FormData, field: string): boolean {
  const raw = form.get(field);
  if (typeof raw !== "string" || (raw !== "true" && raw !== "false")) {
    throw new FormValidationError(field, 'must be the string "true" or "false"');
  }
  return raw === "true";
}

/** Reads a required enum field, fail-closed on missing/out-of-vocabulary. */
function requiredEnum<T extends string>(
  form: FormData,
  field: string,
  vocabulary: readonly T[],
): T {
  const raw = form.get(field);
  if (typeof raw !== "string" || raw.length === 0) {
    throw new FormValidationError(field, "is required");
  }
  if (!vocabulary.includes(raw as T)) {
    throw new FormValidationError(field, `must be one of: ${vocabulary.join(", ")}`);
  }
  return raw as T;
}

/** Reads a multi-valued enum field (checkbox groups), fail-closed on bad values. */
function requiredEnumList<T extends string>(
  form: FormData,
  field: string,
  vocabulary: readonly T[],
): readonly T[] {
  const raw = form.getAll(field);
  if (raw.length === 0) {
    throw new FormValidationError(field, "must include at least one value");
  }
  const values: T[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new FormValidationError(field, "must contain string values only");
    }
    if (!vocabulary.includes(entry as T)) {
      throw new FormValidationError(field, `must be one of: ${vocabulary.join(", ")}`);
    }
    values.push(entry as T);
  }
  return values;
}

/** Reads an optional multi-valued `kind~id` pair list (the support form's related refs). */
function optionalRelatedRefs(
  form: FormData,
  field: string,
): readonly { readonly kind: string; readonly id: string }[] | undefined {
  const raw = form.getAll(field);
  if (raw.length === 0) return undefined;
  const refs: { readonly kind: string; readonly id: string }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new FormValidationError(field, "must contain string values only");
    }
    const separator = entry.indexOf("~");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new FormValidationError(field, "must be a `kind~id` pair (non-empty kind and id)");
    }
    const kind = entry.slice(0, separator);
    const id = entry.slice(separator + 1);
    refs.push({ kind, id });
  }
  return refs;
}

/** Turns one `FormValidationError` into a typed `ApiClientError` for the panel. */
export function formValidationErrorOf(error: FormValidationError): ApiClientError {
  return new ApiClientError({
    kind: "validation",
    reason: "FORM_FIELDS_INVALID",
    message: error.message,
    retryable: false,
    details: [{ path: error.field, issue: error.message }],
    status: 400,
  });
}

// ---------------------------------------------------------------------------
// Per-flow handlers
// ---------------------------------------------------------------------------

/** The dispatch context the HTTP handler hands to each flow's `run` step. */
export interface FlowRunContext {
  readonly app: CustomerWebApp;
  readonly idempotencyKey: string;
}

/** One rendered form action's full handler: parse → run → respond. */
export interface FlowHandler {
  /** The flow's URL slug (the segment after `/flows/`). */
  readonly name: string;
  /** Parses the form-encoded body into the typed flow-method input. Throws `FormValidationError`. */
  parse(form: FormData): unknown;
  /** Calls the matching typed flow method on `CustomerWebApp`. Returns the typed result. */
  run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult>;
  /**
   * Returns the path to re-render after success (with the `lastResult` panel
   * above the body). Returned as a pathname + optional search params so the
   * page's own `params` (step/goal/deviceId/notice, support-context)
   * reconstruct. Flows that redirect-after-post instead return a redirect
   * target from `redirectOnSuccess` and leave this undefined.
   */
  renderPath?(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams };
  /**
   * The redirect-after-post target on success (the connector-enrollment law
   * `/workspace?commandId=<ack.commandId>` and the onboarding-finish law `/`).
   * Returning null falls back to `renderPath` (when both are undefined, the
   * handler answers a typed internal-error — never invented success).
   */
  redirectOnSuccess?(form: FormData, ack: MutationAcknowledgement): string | null;
}

// --- The static render paths (no form-derived params) ----------------------

function staticRenderPath(
  pathname: string,
): (form: FormData) => { readonly pathname: string; readonly searchParams?: URLSearchParams } {
  return () => ({ pathname });
}

// --- Device flows ----------------------------------------------------------

const enrollDeviceFlowHandler: FlowHandler = {
  name: "enroll-device",
  parse(form: FormData): { readonly name: string; readonly platform: DevicePlatform } {
    return {
      name: requiredString(form, "name"),
      platform: requiredEnum(form, "platform", DEVICE_PLATFORMS),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.enrollDeviceFlow(input as { readonly name: string; readonly platform: DevicePlatform }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath: staticRenderPath("/devices"),
};

const updateDeviceFlowHandler: FlowHandler = {
  name: "update-device",
  parse(form: FormData): { readonly deviceId: string; readonly name?: string } {
    const deviceId = requiredString(form, "deviceId");
    const name = optionalString(form, "name");
    return { deviceId, ...(name !== undefined && name.length > 0 ? { name } : {}) };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.updateDeviceFlow(input as { readonly deviceId: string; readonly name?: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const deviceId = requiredString(form, "deviceId");
    return { pathname: `/devices/${encodeURIComponent(deviceId)}` };
  },
};

const retireDeviceFlowHandler: FlowHandler = {
  name: "retire-device",
  parse(form: FormData): { readonly deviceId: string } {
    return { deviceId: requiredString(form, "deviceId") };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.retireDeviceFlow(input as { readonly deviceId: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const deviceId = requiredString(form, "deviceId");
    return { pathname: `/devices/${encodeURIComponent(deviceId)}` };
  },
};

// --- eSIM flows (capability-gated server-side; the page reads the truth) ---

const installEsimProfileFlowHandler: FlowHandler = {
  name: "esim-install",
  parse(form: FormData): { readonly deviceId: string; readonly activationCode: string } {
    return {
      deviceId: requiredString(form, "deviceId"),
      // The rendered form omits `activationCode` when the platform does not
      // require one; the typed API rejects an empty string (requireString),
      // so this stays fail-closed — the host invents NO value.
      activationCode: requiredString(form, "activationCode"),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.installEsimProfileFlow(input as { readonly deviceId: string; readonly activationCode: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const deviceId = requiredString(form, "deviceId");
    return { pathname: `/devices/${encodeURIComponent(deviceId)}/sim` };
  },
};

const removeEsimProfileFlowHandler: FlowHandler = {
  name: "esim-remove",
  parse(form: FormData): { readonly deviceId: string; readonly profileId: string } {
    return {
      deviceId: requiredString(form, "deviceId"),
      profileId: requiredString(form, "profileId"),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.removeEsimProfileFlow(input as { readonly deviceId: string; readonly profileId: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const deviceId = requiredString(form, "deviceId");
    return { pathname: `/devices/${encodeURIComponent(deviceId)}/sim` };
  },
};

const enableEsimProfileFlowHandler: FlowHandler = {
  name: "esim-enable",
  parse(form: FormData): { readonly deviceId: string; readonly profileId: string; readonly enabled: boolean } {
    return {
      deviceId: requiredString(form, "deviceId"),
      profileId: requiredString(form, "profileId"),
      enabled: requiredBoolean(form, "enabled"),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.enableEsimProfileFlow(
      input as { readonly deviceId: string; readonly profileId: string; readonly enabled: boolean },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const deviceId = requiredString(form, "deviceId");
    return { pathname: `/devices/${encodeURIComponent(deviceId)}/sim` };
  },
};

// --- Notification read (recipient-scoped) ----------------------------------

const markNotificationReadFlowHandler: FlowHandler = {
  name: "mark-notification-read",
  parse(form: FormData): { readonly notificationId: string } {
    return { notificationId: requiredString(form, "notificationId") };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.markNotificationReadFlow(input as { readonly notificationId: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath: staticRenderPath("/notifications"),
};

// --- Intent (goal) flows ---------------------------------------------------

const createIntentFlowHandler: FlowHandler = {
  name: "create-intent",
  parse(form: FormData): {
    readonly deviceId: string;
    readonly rationale: string;
    readonly accessClasses: readonly IntentAccessClass[];
  } {
    return {
      deviceId: requiredString(form, "deviceId"),
      rationale: requiredString(form, "rationale"),
      // The typed API rejects an empty accessClasses array (the intent's
      // goal must carry at least one access class); the host fails closed
      // at the seam — no command is attempted for an empty selection.
      accessClasses: requiredEnumList(form, "accessClasses", INTENT_ACCESS_CLASSES),
    };
  },
  async run(
    ctx: FlowRunContext,
    input: unknown,
  ): Promise<MutationFlowResult> {
    return ctx.app.createIntentFlow(
      input as {
        readonly deviceId: string;
        readonly rationale: string;
        readonly accessClasses: readonly IntentAccessClass[];
      },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath: staticRenderPath("/intents"),
};

const activateIntentFlowHandler: FlowHandler = {
  name: "activate-intent",
  parse(form: FormData): { readonly intentId: string } {
    return { intentId: requiredString(form, "intentId") };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.activateIntentFlow(input as { readonly intentId: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const intentId = requiredString(form, "intentId");
    return { pathname: `/intents/${encodeURIComponent(intentId)}` };
  },
};

const supersedeIntentFlowHandler: FlowHandler = {
  name: "supersede-intent",
  parse(form: FormData): {
    readonly intentId: string;
    readonly rationale: string;
    readonly accessClasses: readonly IntentAccessClass[];
  } {
    return {
      intentId: requiredString(form, "intentId"),
      rationale: requiredString(form, "rationale"),
      accessClasses: requiredEnumList(form, "accessClasses", INTENT_ACCESS_CLASSES),
    };
  },
  async run(
    ctx: FlowRunContext,
    input: unknown,
  ): Promise<MutationFlowResult> {
    return ctx.app.supersedeIntentFlow(
      input as {
        readonly intentId: string;
        readonly rationale: string;
        readonly accessClasses: readonly IntentAccessClass[];
      },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const intentId = requiredString(form, "intentId");
    return { pathname: `/intents/${encodeURIComponent(intentId)}` };
  },
};

// --- Support case creation ------------------------------------------------

const createSupportCaseFlowHandler: FlowHandler = {
  name: "create-support-case",
  parse(form: FormData): {
    readonly subject: string;
    readonly description: string;
    readonly priority: SupportPriority;
    readonly relatedRefs?: readonly { readonly kind: string; readonly id: string }[];
  } {
    const subject = requiredString(form, "subject");
    const description = requiredString(form, "description");
    const priority = requiredEnum(form, "priority", SUPPORT_PRIORITIES);
    const relatedRefs = optionalRelatedRefs(form, "relatedRef");
    return { subject, description, priority, ...(relatedRefs !== undefined ? { relatedRefs } : {}) };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.createSupportCaseFlow(
      input as {
        readonly subject: string;
        readonly description: string;
        readonly priority: SupportPriority;
        readonly relatedRefs?: readonly { readonly kind: string; readonly id: string }[];
      },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath: staticRenderPath("/support"),
};

// --- Commerce flows --------------------------------------------------------

const placeOrderFlowHandler: FlowHandler = {
  name: "place-order",
  parse(form: FormData): {
    readonly lines: readonly { readonly variantId: string; readonly quantity: number }[];
  } {
    return {
      lines: [
        {
          variantId: requiredString(form, "variantId"),
          quantity: requiredInteger(form, "quantity"),
        },
      ],
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.placeOrderFlow(
      input as {
        readonly lines: readonly { readonly variantId: string; readonly quantity: number }[];
      },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath: staticRenderPath("/commerce"),
};

const recordPaymentFlowHandler: FlowHandler = {
  name: "record-payment",
  parse(form: FormData): {
    readonly orderId: string;
    readonly amountMinor: number;
    readonly currency: string;
  } {
    return {
      orderId: requiredString(form, "orderId"),
      amountMinor: requiredInteger(form, "amountMinor"),
      currency: requiredString(form, "currency"),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.recordPaymentFlow(
      input as {
        readonly orderId: string;
        readonly amountMinor: number;
        readonly currency: string;
      },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath: staticRenderPath("/commerce"),
};

const cancelOrderFlowHandler: FlowHandler = {
  name: "cancel-order",
  parse(form: FormData): { readonly orderId: string } {
    return { orderId: requiredString(form, "orderId") };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.cancelOrderFlow(input as { readonly orderId: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  renderPath: staticRenderPath("/commerce"),
};

// --- The connector-enrollment redirect law (PA-06 / RL-115-F3) -----------
//
// After a connector-enrollment command the host redirects to
// `/workspace?commandId=<ack.commandId>` so the page renders the command's
// four-stage pipeline from the status read (the polling states). The
// commandId is the durable command's own id (the ack carries it; the page
// resolves it through the typed status read — never fabricated from reads).

const provisionConnectorFlowHandler: FlowHandler = {
  name: "provision-connector",
  parse(form: FormData): { readonly connectorId: string } {
    return { connectorId: requiredString(form, "connectorId") };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.provisionConnectorFlow(input as { readonly connectorId: string }, {
      idempotencyKey: ctx.idempotencyKey,
    });
  },
  // On SUCCESS the connector-enrollment redirect law applies (see below).
  // On FAILURE the originating page (`/workspace`, the page that hosts the
  // form) re-renders with the typed error panel above the body.
  renderPath: staticRenderPath("/workspace"),
  redirectOnSuccess(_form: FormData, ack: MutationAcknowledgement): string | null {
    return `/workspace?commandId=${encodeURIComponent(ack.commandId)}`;
  },
};

// --- The onboarding wizard flows (RL-082) ----------------------------------
//
// `onboarding-enroll-device` enrolls a device through `enrollDeviceFlow`
// (the wizard's step 3 "Add or enroll a device"), then re-renders the device
// step with the chosen goal retained so the customer picks the new device
// for step 4. `onboarding-finish` runs `completeOnboardingFlow` (create +
// activate the goal) and redirects to `/` per the page contract: the customer
// lands on Home.

const onboardingEnrollDeviceFlowHandler: FlowHandler = {
  name: "onboarding-enroll-device",
  parse(form: FormData): {
    readonly goal: OnboardingGoalChoice;
    readonly name: string;
    readonly platform: DevicePlatform;
  } {
    return {
      goal: requiredEnum(form, "goal", ONBOARDING_GOAL_CHOICES),
      name: requiredString(form, "name"),
      platform: requiredEnum(form, "platform", DEVICE_PLATFORMS),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    const typed = input as {
      readonly goal: OnboardingGoalChoice;
      readonly name: string;
      readonly platform: DevicePlatform;
    };
    return ctx.app.enrollDeviceFlow(
      { name: typed.name, platform: typed.platform },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const goal = requiredEnum(form, "goal", ONBOARDING_GOAL_CHOICES);
    const search = new URLSearchParams();
    search.set("step", "device");
    search.set("goal", goal);
    return { pathname: "/onboarding", searchParams: search };
  },
};

const onboardingFinishFlowHandler: FlowHandler = {
  name: "onboarding-finish",
  parse(form: FormData): { readonly goalChoiceId: OnboardingGoalChoice; readonly deviceId: string } {
    return {
      goalChoiceId: requiredEnum(form, "goal", ONBOARDING_GOAL_CHOICES),
      deviceId: requiredString(form, "deviceId"),
    };
  },
  async run(ctx: FlowRunContext, input: unknown): Promise<MutationFlowResult> {
    return ctx.app.completeOnboardingFlow(
      input as { readonly goalChoiceId: OnboardingGoalChoice; readonly deviceId: string },
      { idempotencyKey: ctx.idempotencyKey },
    );
  },
  // On SUCCESS the onboarding-finish law redirects the customer to Home
  // (`/`). On FAILURE (e.g. the read-first activation leg refuses under the
  // uncomposed read model), the originating preferences step re-renders
  // with the typed error panel above the wizard body.
  renderPath(form: FormData): { readonly pathname: string; readonly searchParams?: URLSearchParams } {
    const goal = requiredEnum(form, "goal", ONBOARDING_GOAL_CHOICES);
    const deviceId = requiredString(form, "deviceId");
    const search = new URLSearchParams();
    search.set("step", "preferences");
    search.set("goal", goal);
    search.set("deviceId", deviceId);
    return { pathname: "/onboarding", searchParams: search };
  },
  redirectOnSuccess(): string | null {
    return "/";
  },
};

// ---------------------------------------------------------------------------
// The closed flow table — every rendered form action in apps/web/src/pages/**
// is wired here. A rendered form that POSTs to an unwired action is exactly
// the F-016-1 defect; this table is the host's deliberate union.
// ---------------------------------------------------------------------------

const FLOW_LIST: readonly FlowHandler[] = Object.freeze([
  enrollDeviceFlowHandler,
  updateDeviceFlowHandler,
  retireDeviceFlowHandler,
  installEsimProfileFlowHandler,
  removeEsimProfileFlowHandler,
  enableEsimProfileFlowHandler,
  markNotificationReadFlowHandler,
  createIntentFlowHandler,
  activateIntentFlowHandler,
  supersedeIntentFlowHandler,
  createSupportCaseFlowHandler,
  placeOrderFlowHandler,
  recordPaymentFlowHandler,
  cancelOrderFlowHandler,
  provisionConnectorFlowHandler,
  onboardingEnrollDeviceFlowHandler,
  onboardingFinishFlowHandler,
]);

export const FLOW_HANDLERS: Readonly<Record<string, FlowHandler>> = Object.freeze(
  Object.fromEntries(FLOW_LIST.map((handler) => [handler.name, handler])),
);

/** The closed set of wired flow names (the host's union — F-016-1 closed). */
export const WIRED_FLOW_NAMES: readonly string[] = Object.freeze(
  FLOW_LIST.map((handler) => handler.name),
);

/** The path prefix every flow POSTs under (the apps/web README contract). */
export const FLOW_PATH_PREFIX = "/flows/";
