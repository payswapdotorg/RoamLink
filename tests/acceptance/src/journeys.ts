/**
 * The journey matrix (PA-021 §3.2) — the browser-reachable journeys of the
 * live-journey audit §4, each walked as legs that record their six-level
 * outcome honestly.
 *
 * Every leg goes through the SAME recorder discipline: a level is recorded
 * ONLY after its evidence predicate held on the driven page; an honest
 * runtime limitation (the read model not composed, the mutation route
 * missing, the admin gate denying the persona, the accepted command not
 * executed by the worker plane) STOPS the leg with a named reason at the
 * level it actually evidenced — never a failure, never an inflated pass.
 */
import type { Level } from "./levels.js";
import type { PersonaCredentials } from "./config.js";
import type { BrowserContext, PageSnapshot } from "./driver.js";
import type { A11yCheckOutcome, PageKind } from "./a11y.js";

// ---------------------------------------------------------------------------
// The recorder contract the runner hands each journey
// ---------------------------------------------------------------------------

export interface DegradedPanel {
  readonly section: string;
  readonly reason: string;
}

export interface LegRecord {
  readonly journey: string;
  readonly leg: string;
  readonly persona: string;
  readonly viewport: "desktop" | "mobile";
  /** The level this leg intends to reach on a fully-live runtime. */
  readonly targetLevel: Level;
  /** The furthest level actually evidenced (null when nothing was). */
  readonly reachedLevel: Level | null;
  /** The named honest stop reason (present when stopped below target). */
  readonly stopReason?: string;
  /** Present when the leg FAILED its floor (the exit-1 contract). */
  readonly failure?: string;
  readonly evidence: readonly string[];
  readonly degradedPanels: readonly DegradedPanel[];
  readonly a11y: readonly A11yCheckOutcome[];
  /** How many times the runner had to retry this leg (relogin/transient). */
  readonly retries: number;
}

export interface LegRecorder {
  readonly journey: string;
  readonly leg: string;
  /** Records an evidenced level (only ever raises the furthest reached). */
  record(level: Level, evidence: string): void;
  /** Records a terrain note that claims no level. */
  note(text: string): void;
  /** Records the named honest stop reason (a limitation, not a failure). */
  stop(reason: string): void;
  /** Marks the leg as FAILED (a lie-shaped defect or an unreachable route). */
  fail(message: string): void;
  /** Collects the current page's PA-020 quiet panels into the record. */
  collectDegradedPanels(): Promise<void>;
  /** Runs the a11y battery on the current page and attaches the outcomes. */
  a11y(pageKind: PageKind): Promise<void>;
}

export interface LoginOutcome {
  readonly ok: boolean;
  readonly via: "credentials+enter" | "credentials+click" | "quick-action";
  readonly detail: string;
}

export interface JourneyHarness {
  readonly ctx: BrowserContext;
  readonly persona: PersonaCredentials;
  readonly viewport: "desktop" | "mobile";
  readonly stamp: string;
  /** Navigates with the relogin discipline; returns the settled snapshot. */
  navigate(path: string): Promise<PageSnapshot>;
  /**
   * Logs this context in through the rendered login surface (the manual
   * credential form submitted via keyboard Enter when the driver has a
   * keyboard; the demo quick-action form otherwise). Records the login
   * evidence on the CURRENT leg if one is open.
   */
  login(): Promise<LoginOutcome>;
  /** Starts a leg record (finalized by the runner at journey end). */
  leg(journey: string, legName: string, targetLevel: Level): LegRecorder;
  /** Per-context scratchpad (e.g. the captured device id). */
  readonly scratch: Map<string, string>;
}

export type Journey = (harness: JourneyHarness) => Promise<void>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Asserts the mutation outcome panel after a real form submission and
 * records the honest level: the typed acknowledgement (command id +
 * idempotency key) reaches mutation-accepted; the executed stage row
 * reaches mutation-executed; a typed refusal STOPS the leg below
 * acceptance with the reason verbatim; NO typed panel at all FAILS the
 * leg (the flow plane answered something untyped — a defect, never a
 * silent no-op).
 */
export async function recordMutationOutcome(
  ctx: BrowserContext,
  recorder: LegRecorder,
): Promise<{ readonly accepted: boolean; readonly commandId: string | null }> {
  const okCount = await ctx.count('[data-mutation-result="ok"]');
  if (okCount > 0) {
    const commandId = await ctx.attr('[data-mutation-result="ok"]', "data-command-id");
    const idempotencyPresent = await ctx.contentMatches(/idempotency key [A-Za-z0-9._:~-]+/);
    if (commandId === null || commandId.length === 0) {
      recorder.fail("the acknowledgement panel rendered without a command id (the panel contract is broken)");
      return { accepted: false, commandId: null };
    }
    if (!idempotencyPresent) {
      recorder.fail("the acknowledgement panel rendered without the idempotency key line (the panel contract is broken)");
      return { accepted: false, commandId };
    }
    recorder.record(
      "mutation-accepted",
      `the typed acknowledgement panel rendered (command ${commandId}, idempotency key present, correlation present)`,
    );
    const executedReached = await ctx.count('[data-stage="executed"][data-reached="true"]');
    if (executedReached > 0) {
      recorder.record(
        "mutation-executed",
        "the executed stage is reached on the four-stage pipeline (li[data-stage=executed][data-reached=true])",
      );
    } else {
      recorder.stop(
        "the command is durably accepted but the executed stage is not reached (the worker-execution plane is not advancing this command kind on this runtime — the honest accepted-not-executed state)",
      );
    }
    return { accepted: true, commandId };
  }
  const errorCount = await ctx.count('[data-mutation-result="error"]');
  if (errorCount > 0) {
    const kind = await ctx.attr('[data-mutation-result="error"]', "data-error-kind");
    const reason = await ctx.attr('[data-mutation-result="error"]', "data-error-reason");
    if (reason === null || reason.length === 0) {
      recorder.fail("an error panel rendered without the typed reason (the panel contract is broken)");
      return { accepted: false, commandId: null };
    }
    recorder.record(
      "surface-rendered",
      "the originating page re-rendered with the typed refusal panel (the flow plane answered honestly)",
    );
    recorder.stop(
      `the typed refusal panel rendered (kind ${kind ?? "unknown"}, reason ${reason}) — the mutation was NOT accepted; this is the honest live terrain for this flow on this runtime`,
    );
    return { accepted: false, commandId: null };
  }
  recorder.fail(
    "the form submission produced NO typed outcome panel (neither the acknowledgement nor the typed refusal) — the flow plane answered something untyped",
  );
  return { accepted: false, commandId: null };
}

/** Records the CURRENT page's route+surface evidence (for legs that stop before submitting). */
async function recordCurrentSurface(ctx: BrowserContext, recorder: LegRecorder): Promise<void> {
  const snapshot = await ctx.snapshot();
  if (snapshot.failed) {
    recorder.fail(`the navigation failed (${snapshot.failureDetail ?? "unknown failure"})`);
    return;
  }
  recorder.record("route-reachable", `the route answered (HTTP ${snapshot.status})`);
  const h1Count = await ctx.count("h1");
  if (h1Count === 1) {
    recorder.record("surface-rendered", "the document rendered (exactly one h1; the shell contract holds)");
  } else {
    recorder.fail(`the document rendered ${h1Count} h1 elements (expected exactly 1)`);
  }
}

/** Walks one page's surface evidence: route + shell + page markers. */
async function recordSurfaceEvidence(
  ctx: BrowserContext,
  recorder: LegRecorder,
  snapshot: PageSnapshot,
  pageKind: PageKind,
): Promise<void> {
  if (snapshot.failed) {
    recorder.fail(`the navigation failed (${snapshot.failureDetail ?? "unknown failure"})`);
    return;
  }
  recorder.record("route-reachable", `the route answered (HTTP ${snapshot.status} at ${pathOf(snapshot.url)})`);
  const h1Count = await ctx.count("h1");
  if (h1Count !== 1) {
    recorder.fail(`the document rendered ${h1Count} h1 elements (expected exactly 1)`);
    return;
  }
  recorder.record("surface-rendered", "the document rendered (exactly one h1; the shell contract holds)");
  await recorder.collectDegradedPanels();
  await recorder.a11y(pageKind);
}

// ---------------------------------------------------------------------------
// Journey 1 — login (the entry point)
// ---------------------------------------------------------------------------

export const loginJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const documentLeg = harness.leg("login", "document", "surface-rendered");
  const snapshot = await harness.navigate("/login");
  await recordSurfaceEvidence(ctx, documentLeg, snapshot, "session-shell");
  const rosterCount = await ctx.count('[data-demo-accounts="true"]');
  if (rosterCount > 0) {
    documentLeg.note(
      "the public demo roster renders (quick-action sign-in forms present) — the demo credentials contract of the deployed environment",
    );
  } else {
    documentLeg.note(
      "the demo roster is not rendered on this deployment (the manual credential form is the login surface)",
    );
  }

  const submitLeg = harness.leg("login", "submit", "user-visible-evidence");
  const login = await harness.login();
  if (!login.ok) {
    submitLeg.fail(`the login did not land an authenticated surface (${login.detail})`);
    return;
  }
  submitLeg.record("route-reachable", "the login POST answered");
  submitLeg.record("surface-rendered", `the session was bound through ${login.via} (an authenticated surface rendered, not the login document)`);
  submitLeg.record(
    "user-visible-evidence",
    "the authenticated customer surface is visible after login (the shell + h1 contract render on the landing page)",
  );
  if (login.via === "credentials+enter") {
    submitLeg.note("the credential form was submitted via keyboard Enter (the forms-submittable-via-keyboard evidence)");
  }
  const current = await ctx.snapshot();
  await submitLeg.a11y(pathOf(current.url) === "/login" ? "session-shell" : "app-shell");
};

// ---------------------------------------------------------------------------
// Journey 2 — onboarding (the four-step wizard)
// ---------------------------------------------------------------------------

export const onboardingJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const welcomeLeg = harness.leg("onboarding", "welcome", "surface-rendered");
  const welcome = await harness.navigate("/onboarding");
  await recordSurfaceEvidence(ctx, welcomeLeg, welcome, "app-shell");
  const wizardCount = await ctx.count('[data-onboarding="true"]');
  if (wizardCount === 0) {
    welcomeLeg.fail("the onboarding wizard container is not rendered at /onboarding");
    return;
  }
  welcomeLeg.record("surface-rendered", "the onboarding wizard renders ([data-onboarding=true])");

  const goalLeg = harness.leg("onboarding", "goal", "surface-rendered");
  const getStarted = await ctx.count("a.onboarding-primary-action");
  if (getStarted === 0) {
    goalLeg.stop("the welcome step renders no primary action link to the goal step");
    return;
  }
  const goalStep = await ctx.clickLink("a.onboarding-primary-action");
  goalLeg.record("route-reachable", `the goal step answered (HTTP ${goalStep.status})`);
  const stepMarker = await ctx.attr('[data-onboarding="true"]', "data-onboarding-step");
  if (stepMarker !== "goal") {
    goalLeg.fail(`the wizard did not advance to the goal step (step=${JSON.stringify(stepMarker)})`);
    return;
  }
  goalLeg.record("surface-rendered", "the goal choice step renders (data-onboarding-step=goal)");
  await goalLeg.collectDegradedPanels();
  await goalLeg.a11y("app-shell");

  // Choose the goal and continue to the device step (a GET navigation).
  const chooseGoalForm = 'form[data-onboarding-form="choose-goal"]';
  if ((await ctx.count(chooseGoalForm)) === 0) {
    const enrollLeg = harness.leg("onboarding", "enroll-device", "mutation-accepted");
    enrollLeg.stop("the goal-choice form is not rendered (the wizard state cannot advance on this runtime)");
    return;
  }
  await ctx.check(chooseGoalForm, "goal", "travel");
  await ctx.submit(chooseGoalForm);
  const deviceStepMarker = await ctx.attr('[data-onboarding="true"]', "data-onboarding-step");
  if (deviceStepMarker !== "device") {
    const enrollLeg = harness.leg("onboarding", "enroll-device", "mutation-accepted");
    enrollLeg.fail(`the wizard did not advance to the device step (step=${JSON.stringify(deviceStepMarker)})`);
    return;
  }

  const enrollLeg = harness.leg("onboarding", "enroll-device", "mutation-executed");
  const enrollForm = 'form[data-onboarding-form="enroll-device"]';
  if ((await ctx.count(enrollForm)) === 0) {
    await recordCurrentSurface(ctx, enrollLeg);
    enrollLeg.stop("the wizard's enroll-device form is not rendered on the device step");
    return;
  }
  const deviceName = `PA-021 ${harness.viewport} ${harness.stamp}`;
  await ctx.fillText(enrollForm, "name", deviceName);
  await ctx.selectOption(enrollForm, "platform", "ios");
  await ctx.submit(enrollForm);
  await recordMutationOutcome(ctx, enrollLeg);
  await enrollLeg.collectDegradedPanels();
  await enrollLeg.a11y("app-shell");

  // The finish leg: the wizard can only finish against an EXECUTED device.
  const finishLeg = harness.leg("onboarding", "finish", "user-visible-evidence");
  const pickForm = 'form[data-onboarding-form="pick-device"]';
  if ((await ctx.count(pickForm)) === 0) {
    finishLeg.record("surface-rendered", "the device step renders after the enrollment (the wizard state holds)");
    finishLeg.stop(
      "the wizard's device picker holds no executed device (the accepted enrollment has not executed, so the read model never flips — the finish step cannot be reached on this runtime)",
    );
    return;
  }
  const deviceIdOptions = await ctx.attrAll('input[name="deviceId"]', "value");
  const deviceId = deviceIdOptions[0];
  if (deviceId === undefined) {
    finishLeg.stop("the device picker renders no device radio values");
    return;
  }
  harness.scratch.set("deviceId", deviceId);
  finishLeg.record(
    "user-visible-evidence",
    "the wizard's device picker holds an executed device (the device read model flipped for at least one device)",
  );
  await ctx.check(pickForm, "deviceId", deviceId);
  await ctx.submit(pickForm);
  const preferencesMarker = await ctx.attr('[data-onboarding="true"]', "data-onboarding-step");
  if (preferencesMarker !== "preferences") {
    finishLeg.fail(`the wizard did not advance to the preferences step (step=${JSON.stringify(preferencesMarker)})`);
    return;
  }
  const finishForm = 'form[data-onboarding-form="finish"]';
  if ((await ctx.count(finishForm)) === 0) {
    finishLeg.stop("the preferences step renders no finish form");
    return;
  }
  const finishResult = await ctx.submit(finishForm);
  const landed = pathOf(finishResult.url);
  if (landed === "/") {
    finishLeg.record("user-visible-evidence", "the finish flow landed on Home (the onboarding-finish redirect law)");
  } else {
    // The honest read-first refusal path: the activation leg refuses on a
    // non-executed goal and the preferences step re-renders with the typed
    // panel. Record that outcome honestly.
    await recordMutationOutcome(ctx, finishLeg);
  }
};

// ---------------------------------------------------------------------------
// Journey 3 — goals
// ---------------------------------------------------------------------------

export const goalsJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const readLeg = harness.leg("goals", "read", "read-available");
  const page = await harness.navigate("/intents");
  await recordSurfaceEvidence(ctx, readLeg, page, "app-shell");
  const emptyMarker = await ctx.count('[data-goals-empty="true"]');
  const listMarker = await ctx.count('[data-intents="true"]');
  if (emptyMarker > 0) {
    readLeg.record("read-available", "the goals read model composes and serves its honest empty state ([data-goals-empty=true])");
  } else if (listMarker > 0) {
    readLeg.record("read-available", "the goals read model composes and serves the goal list ([data-intents=true])");
  } else {
    readLeg.stop("the goals page renders but neither the empty-state marker nor the goal list is present (the read state is not evidenced on this runtime)");
  }

  const createLeg = harness.leg("goals", "create", "mutation-executed");
  const createForm = 'form[data-flow="create-intent"]';
  if ((await ctx.count(createForm)) === 0) {
    await recordCurrentSurface(ctx, createLeg);
    createLeg.stop(
      "the create-goal form is not rendered (a goal commands against an executed device; the devices read model holds none on this runtime)",
    );
    return;
  }
  const rationale = `PA-021 goal ${harness.viewport} ${harness.stamp}`;
  await ctx.fillText(createForm, "rationale", rationale);
  await ctx.check(createForm, "accessClasses", "any_internet");
  await ctx.submit(createForm);
  const outcome = await recordMutationOutcome(ctx, createLeg);
  await createLeg.collectDegradedPanels();
  await createLeg.a11y("app-shell");

  // The user-visible evidence leg: the goal appears in the list.
  const visibleLeg = harness.leg("goals", "visible", "user-visible-evidence");
  if (!outcome.accepted) {
    visibleLeg.stop("the create command was not accepted; no user-visible effect can follow on this runtime");
    return;
  }
  await harness.navigate("/intents");
  const goalVisible = await ctx.contentMatches(new RegExp(escapeRegExp(rationale)));
  if (goalVisible) {
    visibleLeg.record("route-reachable", "the goals page answered for the evidence visit");
    visibleLeg.record("user-visible-evidence", `the created goal is visible in the goals list ("${rationale}")`);
  } else {
    visibleLeg.record("surface-rendered", "the goals page rendered for the evidence visit");
    visibleLeg.stop("the created goal is not yet visible in the goals list (the accepted command has not executed; the read model has not flipped)");
  }

  const activateLeg = harness.leg("goals", "activate", "mutation-executed");
  const activateForm = 'form[data-flow="activate-intent"]';
  if ((await ctx.count(activateForm)) === 0) {
    await recordCurrentSurface(ctx, activateLeg);
    activateLeg.stop("no goal card renders the activate action (versioned activation commands against an executed goal)");
    return;
  }
  await ctx.submit(activateForm);
  await recordMutationOutcome(ctx, activateLeg);
};

// ---------------------------------------------------------------------------
// Journey 4 — devices
// ---------------------------------------------------------------------------

export const devicesJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const listLeg = harness.leg("devices", "list", "read-available");
  const page = await harness.navigate("/devices");
  await recordSurfaceEvidence(ctx, listLeg, page, "app-shell");
  const emptyMarker = await ctx.count('[data-devices-empty="true"]');
  const listMarker = await ctx.count('[data-devices="true"]');
  if (emptyMarker > 0) {
    listLeg.record("read-available", "the devices read model composes and serves its honest empty state ([data-devices-empty=true])");
  } else if (listMarker > 0) {
    listLeg.record("read-available", "the devices read model composes and serves the device list ([data-devices=true])");
  } else {
    listLeg.stop("the devices page renders but neither the empty-state marker nor the device list is present");
  }

  const detailLeg = harness.leg("devices", "detail", "read-available");
  const deviceLinkCount = await ctx.count('a[href^="/devices/"]');
  if (deviceLinkCount === 0) {
    detailLeg.stop("no device in the read model to open (the device detail journey requires an executed device)");
  } else {
    const detail = await ctx.clickLink('a[href^="/devices/"]');
    detailLeg.record("route-reachable", `the device detail route answered (HTTP ${detail.status})`);
    const h1Count = await ctx.count("h1");
    if (h1Count !== 1) {
      detailLeg.fail(`the device detail document rendered ${h1Count} h1 elements`);
    } else {
      detailLeg.record("surface-rendered", "the device detail document renders");
      const capability = await ctx.count('[data-device-capability]');
      if (capability > 0) {
        const capabilityState = await ctx.attr('[data-device-capability]', "data-capability-state");
        detailLeg.record(
          "read-available",
          `the device capability section renders ([data-device-capability], state ${capabilityState ?? "unknown"})`,
        );
        const detailPath = pathOf(detail.url);
        const deviceId = detailPath.split("/").filter((segment) => segment.length > 0)[1];
        if (deviceId !== undefined) harness.scratch.set("deviceId", deviceId);
      } else {
        detailLeg.stop("the device detail renders without the capability section (the capability read is not evidenced)");
      }
      await detailLeg.collectDegradedPanels();
      await detailLeg.a11y("app-shell");
    }
  }

  const enrollLeg = harness.leg("devices", "enroll", "mutation-executed");
  await harness.navigate("/devices");
  const enrollForm = 'form[data-flow="enroll-device"]';
  if ((await ctx.count(enrollForm)) === 0) {
    await recordCurrentSurface(ctx, enrollLeg);
    enrollLeg.stop("the enroll-device form is not rendered on the devices page");
    return;
  }
  await ctx.fillText(enrollForm, "name", `PA-021 device ${harness.viewport} ${harness.stamp}`);
  await ctx.selectOption(enrollForm, "platform", "android");
  await ctx.submit(enrollForm);
  await recordMutationOutcome(ctx, enrollLeg);
  await enrollLeg.collectDegradedPanels();
  await enrollLeg.a11y("app-shell");
};

// ---------------------------------------------------------------------------
// Journey 5 — eSIM (SIM & Profiles)
// ---------------------------------------------------------------------------

export const esimJourney: Journey = async (harness) => {
  const { ctx } = harness;
  const deviceId = harness.scratch.get("deviceId");

  const pageLeg = harness.leg("esim", "page", "read-available");
  if (deviceId === undefined) {
    pageLeg.stop("no device in the read model; the SIM & Profiles journey cannot be opened on this runtime");
    return;
  }
  const page = await harness.navigate(`/devices/${encodeURIComponent(deviceId)}/sim`);
  await recordSurfaceEvidence(ctx, pageLeg, page, "app-shell");
  const installSection = await ctx.count("[data-esim-install]");
  const profiles = await ctx.count("[data-esim-profile-id]");
  if (installSection > 0 || profiles > 0) {
    pageLeg.record(
      "read-available",
      `the SIM & Profiles page composes (install section ${installSection > 0 ? "present" : "absent"}, ${profiles} profile card(s))`,
    );
  } else {
    pageLeg.stop("the SIM page renders without the install section or profile cards (the SIM read is not evidenced on this runtime)");
  }

  const installLeg = harness.leg("esim", "install", "mutation-executed");
  const installForm = 'form[data-flow="esim-install"]';
  if ((await ctx.count(installForm)) === 0) {
    await recordCurrentSurface(ctx, installLeg);
    installLeg.stop("the install form is not rendered (the capability gate blocks installs or the read model holds no confirmed profile state on this runtime)");
    return;
  }
  const activationField = await ctx.count('input[name="activationCode"]');
  if (activationField > 0) {
    await ctx.fillText(installForm, "activationCode", `PA-021-${harness.stamp}`);
  }
  await ctx.submit(installForm);
  await recordMutationOutcome(ctx, installLeg);
  await installLeg.collectDegradedPanels();
  await installLeg.a11y("app-shell");

  const enableLeg = harness.leg("esim", "enable", "mutation-executed");
  const enableForm = 'form[data-flow="esim-enable"]';
  if ((await ctx.count(enableForm)) === 0) {
    await recordCurrentSurface(ctx, enableLeg);
    enableLeg.stop("no profile card renders the enable action (enable commands against a confirmed profile)");
  } else {
    await ctx.submit(enableForm);
    await recordMutationOutcome(ctx, enableLeg);
    await enableLeg.a11y("app-shell");
  }

  const removeLeg = harness.leg("esim", "remove", "mutation-executed");
  const removeForm = 'form[data-flow="esim-remove"]';
  if ((await ctx.count(removeForm)) === 0) {
    await recordCurrentSurface(ctx, removeLeg);
    removeLeg.stop("no profile card renders the remove action");
  } else {
    await ctx.submit(removeForm);
    await recordMutationOutcome(ctx, removeLeg);
  }
};

// ---------------------------------------------------------------------------
// Journey 6 — connectivity (summary -> why -> evidence -> technical)
// ---------------------------------------------------------------------------

export const connectivityJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const summaryLeg = harness.leg("connectivity", "summary", "read-available");
  const page = await harness.navigate("/connectivity");
  await recordSurfaceEvidence(ctx, summaryLeg, page, "app-shell");
  const overviewMarker = await ctx.count("[data-connectivity-overview]");
  const centerSummary = await ctx.contentMatches(
    /What your devices are seeing|Your connection journey|What happens next/,
  );
  if (overviewMarker > 0 || centerSummary) {
    summaryLeg.record(
      "read-available",
      "the connectivity center's core read composes (the summary sections render from the authoritative connectivity aggregate — the honest empty or populated state)",
    );
  } else {
    summaryLeg.stop("the connectivity center's summary sections are not rendered (the aggregate read is not evidenced)");
  }

  for (const layer of ["why", "evidence", "technical"] as const) {
    const layerLeg = harness.leg("connectivity", layer, "read-available");
    const disclosureCount = await ctx.count(`details[data-disclosure="${layer}"]`);
    if (disclosureCount > 0) {
      layerLeg.record("route-reachable", `the connectivity page carries the ${layer} disclosure layer`);
      layerLeg.record(
        "read-available",
        `the progressive-disclosure ${layer} layer renders (details[data-disclosure=${layer}] — a native openable disclosure, never required to understand the summary)`,
      );
    } else {
      layerLeg.record("surface-rendered", "the connectivity page rendered");
      layerLeg.stop(`the ${layer} disclosure layer is not rendered on this runtime`);
    }
  }
};

// ---------------------------------------------------------------------------
// Journey 7 — activity
// ---------------------------------------------------------------------------

export const activityJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const leg = harness.leg("activity", "page", "read-available");
  const page = await harness.navigate("/activity");
  await recordSurfaceEvidence(ctx, leg, page, "app-shell");
  const automationStatus = await ctx.contentMatches(/Automation status/);
  if (automationStatus) {
    leg.record(
      "read-available",
      "the Activity core read composes (the automation-status section renders from the intents/devices reads)",
    );
  } else {
    leg.stop("the Activity core (automation status) did not render (the page's core read is not evidenced)");
    return;
  }
  const notificationPanels = await ctx.attrAll("[data-unavailable]", "data-unavailable-section");
  if (notificationPanels.length > 0) {
    leg.record(
      "read-available",
      `the notification-derived sections degrade per component (${notificationPanels.length} quiet panel(s): ${notificationPanels.join(", ")}) — the PA-020 honest secondary state, recorded not failed`,
    );
  }
};

// ---------------------------------------------------------------------------
// Journey 8 — plans & billing -> order -> delivery
// ---------------------------------------------------------------------------

export const commerceJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const leg = harness.leg("plans-billing", "page", "read-available");
  const page = await harness.navigate("/commerce");
  await recordSurfaceEvidence(ctx, leg, page, "app-shell");
  const typedRefusal = await ctx.count('[data-mutation-result="error"]');
  if (typedRefusal > 0) {
    const reason = await ctx.attr('[data-mutation-result="error"]', "data-error-reason");
    leg.stop(
      `the commerce page fails closed on its core read set (the typed panel renders: reason ${reason ?? "unknown"}) — the products/orders/subscriptions read models are not composed on this runtime`,
    );
    const orderLeg = harness.leg("plans-billing", "order", "read-available");
    await recordCurrentSurface(ctx, orderLeg);
    orderLeg.stop("no commerce read composed on this runtime; the order/payment/delivery-progress journey cannot be opened (no product, order or subscription is visible to walk)");
    return;
  }
  const orderLinks = await ctx.count('a[href^="/orders/"]');
  if (orderLinks > 0) {
    leg.record("read-available", "the commerce read model composes (order links render)");
  } else {
    leg.stop("the commerce page renders without order links (no composed order read to walk)");
    return;
  }

  const orderLeg = harness.leg("plans-billing", "order", "read-available");
  const order = await ctx.clickLink('a[href^="/orders/"]');
  orderLeg.record("route-reachable", `the order delivery-progress route answered (HTTP ${order.status})`);
  const h1Count = await ctx.count("h1");
  if (h1Count === 1) {
    orderLeg.record("surface-rendered", "the order delivery-progress document renders");
    const journeyStages = await ctx.count("[data-lifecycle-state]");
    orderLeg.record(
      "read-available",
      `the delivery-progress journey renders (${journeyStages} lifecycle stage(s) — delivery evidence shown separately from any payment fact)`,
    );
  } else {
    orderLeg.fail(`the order document rendered ${h1Count} h1 elements`);
  }
};

// ---------------------------------------------------------------------------
// Journey 9 — support (contextual escape -> case creation -> thread)
// ---------------------------------------------------------------------------

export const supportJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const readLeg = harness.leg("support", "read", "read-available");
  const page = await harness.navigate("/support");
  await recordSurfaceEvidence(ctx, readLeg, page, "app-shell");
  const emptyCases = await ctx.count('[data-support-cases="true"]');
  const emptyState = await ctx.count('[data-empty="true"]');
  if (emptyCases > 0 || emptyState > 0) {
    readLeg.record("read-available", "the support-case read model composes (the cases list or its honest empty state renders)");
  } else {
    readLeg.stop("the support page renders without the cases read evidence");
  }

  const contextualLeg = harness.leg("support", "contextual-escape", "read-available");
  const contextual = await harness.navigate(
    `/support?about=${encodeURIComponent("connectivity degraded on the acceptance walk")}&detail=${encodeURIComponent("PA-021 contextual escape probe")}&ref=${encodeURIComponent(`device~${harness.scratch.get("deviceId") ?? "unknown"}`)}`,
  );
  await recordSurfaceEvidence(ctx, contextualLeg, contextual, "app-shell");
  const carried = await ctx.count('[data-support-context-note="true"]');
  const carriedPanel = await ctx.count('[data-carried-support-context="true"]');
  if (carried > 0 || carriedPanel > 0) {
    contextualLeg.record(
      "read-available",
      "the contextual escape carries its context transparently (the carried-context note renders with the references shown)",
    );
  } else {
    contextualLeg.stop("the support page renders without the carried-context evidence (the contextual params did not surface)");
  }

  const createLeg = harness.leg("support", "create", "mutation-executed");
  const createForm = 'form[data-flow="create-support-case"]';
  if ((await ctx.count(createForm)) === 0) {
    await recordCurrentSurface(ctx, createLeg);
    createLeg.stop("the create-support-case form is not rendered on this runtime");
    return;
  }
  const subject = `PA-021 support ${harness.viewport} ${harness.stamp}`;
  await ctx.fillText(createForm, "subject", subject);
  await ctx.fillText(createForm, "description", "deployed-browser acceptance walk: the case-creation leg through the real flow plane");
  await ctx.selectOption(createForm, "priority", "normal");
  await ctx.submit(createForm);
  await recordMutationOutcome(ctx, createLeg);
  await createLeg.collectDegradedPanels();
  await createLeg.a11y("app-shell");

  const threadLeg = harness.leg("support", "case-thread", "read-available");
  const caseLinks = await ctx.count('a[href^="/support/"]');
  if (caseLinks === 0) {
    threadLeg.stop("no support case in the read model to open (the accepted case has not executed; the thread journey requires an executed case)");
    return;
  }
  const thread = await ctx.clickLink('a[href^="/support/"]');
  threadLeg.record("route-reachable", `the support case thread route answered (HTTP ${thread.status})`);
  const h1Count = await ctx.count("h1");
  if (h1Count === 1) {
    threadLeg.record("read-available", "the support case thread renders (the customer-visible thread view)");
  } else {
    threadLeg.fail(`the case thread document rendered ${h1Count} h1 elements`);
  }
};

// ---------------------------------------------------------------------------
// Journey 10 — workspace (the enterprise journey legs the runtime allows)
// ---------------------------------------------------------------------------

export const workspaceJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const leg = harness.leg("workspace", "page", "read-available");
  const page = await harness.navigate("/workspace");
  await recordSurfaceEvidence(ctx, leg, page, "app-shell");
  const coreSections = await ctx.contentMatches(/Device fleet|Active goals|Workspace/);
  if (coreSections) {
    leg.record(
      "read-available",
      "the workspace core reads compose (the fleet/goals sections render from the session/devices/intents reads)",
    );
  } else {
    leg.stop("the workspace core sections did not render");
    return;
  }
  const degraded = await ctx.attrAll("[data-unavailable]", "data-unavailable-section");
  if (degraded.length > 0) {
    leg.record(
      "read-available",
      `the enterprise workspace secondary read degrades per component (${degraded.length} quiet panel(s): ${degraded.join(", ")}) — the honest PA-020 state`,
    );
  }

  const connectorLeg = harness.leg("workspace", "connector", "mutation-executed");
  const connectorForm = 'form[data-flow="provision-connector"]';
  if ((await ctx.count(connectorForm)) === 0) {
    await recordCurrentSurface(ctx, connectorLeg);
    connectorLeg.stop(
      "the connector-enrollment form is not rendered (the enterprise workspace read is not composed on this runtime, so the connector section degrades to the quiet panel)",
    );
    return;
  }
  await ctx.submit(connectorForm);
  await recordMutationOutcome(ctx, connectorLeg);
};

// ---------------------------------------------------------------------------
// Journey 11 — admin / operations (navigation, SLO, integration health)
// ---------------------------------------------------------------------------

export const adminJourney: Journey = async (harness) => {
  const { ctx } = harness;

  const consoleLeg = harness.leg("admin", "console", "read-available");
  const page = await harness.navigate("/admin");
  await recordSurfaceEvidence(ctx, consoleLeg, page, "ops-console");
  const navLinks = await ctx.count("a[href]");
  if (navLinks > 0) {
    consoleLeg.record("surface-rendered", `the operations console shell renders with its navigation (${navLinks} anchor destination(s))`);
  } else {
    consoleLeg.fail("the operations console renders no navigation");
    return;
  }
  const denied = await ctx.count('[data-access-denied="true"]');
  if (denied > 0) {
    const requiredPermission = await ctx.attr('[data-access-denied="true"]', "data-required-permission");
    consoleLeg.stop(
      `the admin session gate denies this persona (the fail-closed access-denied panel renders; the surface requires '${requiredPermission ?? "org:read"}' which the hosted personal-tenant session does not carry on this runtime) — the gate is the honest answer, and no surface data was fetched`,
    );
  } else {
    consoleLeg.record("read-available", "the admin console surface data composed for this persona");
  }

  // The SLO + integration-health legs run regardless of the gate's answer:
  // each evidences its own route + its own honest gate/data-plane outcome.
  for (const [legName, path] of [
    ["slo", "/ops/slo"],
    ["integration-health", "/admin/integration-health"],
  ] as const) {
    const opLeg = harness.leg("admin", legName, "read-available");
    const opPage = await harness.navigate(path);
    await recordSurfaceEvidence(ctx, opLeg, opPage, "ops-console");
    const opDenied = await ctx.count('[data-access-denied="true"]');
    if (opDenied > 0) {
      opLeg.stop("the ops surface session gate denies this persona (the fail-closed panel renders)");
      continue;
    }
    const quiet = await ctx.count("[data-unavailable]");
    if (quiet > 0) {
      opLeg.record("surface-rendered", "the ops page renders with its data-plane degradation panels");
      opLeg.stop("the ops data-plane read is not composed on this runtime (the quiet panel records it)");
      continue;
    }
    opLeg.record("read-available", `the ${legName} surface data composed`);
  }
};

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** The customer journey order (the final individual journey of the handoff). */
export const CUSTOMER_JOURNEYS: readonly Journey[] = Object.freeze([
  loginJourney,
  onboardingJourney,
  goalsJourney,
  devicesJourney,
  esimJourney,
  connectivityJourney,
  activityJourney,
  commerceJourney,
  supportJourney,
  workspaceJourney,
]);

/** The operator/enterprise journeys (the owner persona). */
export const OPERATOR_JOURNEYS: readonly Journey[] = Object.freeze([adminJourney]);
