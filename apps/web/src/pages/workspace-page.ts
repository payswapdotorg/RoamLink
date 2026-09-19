/**
 * The enterprise workspace + guided onboarding journey (RL-104,
 * spec/tech-lead-handoff.md §11, spec/ux-architecture.md §12/§13).
 *
 * The FROZEN chain this page renders as a guided visual journey:
 *
 *   workspace -> organization verification -> policy -> connector ->
 *   devices -> capability verification -> first goal -> live organization
 *   overview
 *
 * THE HARD LAW: "Enterprise UX is not allowed to create a second
 * connectivity authority." This page renders organization connectivity
 * facts THROUGH the same ConnectivityOverviewResource every other page
 * uses - no aggregation layer, no derived org connectivity state beyond
 * the shared shell derivation (a presentation explanation, not an
 * authority).
 *
 * Honest-by-construction:
 *  - every journey step renders one of the closed states (complete /
 *    waiting / action-needed / blocked / not-started / not-available);
 *  - the enterprise read contract (enrollment/connector) arrives through
 *    @roamlink/app-kit's mirrored vocabularies - never a direct
 *    enterprise dependency, never a redefined state;
 *  - sections the API does not yet expose (org policy read; cross-
 *    workspace switching; the audit trail surface) render the honest
 *    not-yet-available state instead of invented content;
 *  - admin/diagnostics stay out (spec §13): the page links to the
 *    customer Activity narrative, never to raw audit/protocol surfaces;
 *  - support is reachable (the escape pre-carries the workspace
 *    reference - which is the org tenant itself).
 *
 * Pure function over parsed read models.
 */
import {
  connectivitySubjectCard,
  deriveShellConnectivityState,
  SHELL_CONNECTIVITY_LANGUAGE,
  freshnessBadge,
  stateBadge,
  el,
  fragment,
  text,
  type ActorSessionResource,
  type ConnectivityOverviewResource,
  type DeviceResource,
  type EnterpriseWorkspaceResource,
  type ExperienceIntentResource,
  type HtmlFragment,
} from "@roamlink/app-kit";

import { pagePath } from "../routes.js";
import { pageHeading } from "../app.js";
import { supportEscape } from "./support-context.js";

export interface WorkspacePageInput {
  readonly session: ActorSessionResource;
  readonly workspace: EnterpriseWorkspaceResource;
  readonly devices: readonly DeviceResource[];
  readonly intents: readonly ExperienceIntentResource[];
  readonly connectivity: ConnectivityOverviewResource;
}

/** The closed guided-journey step keys (the frozen chain, in order). */
export const WORKSPACE_JOURNEY_STEPS = [
  "workspace",
  "organization-verification",
  "policy",
  "connector",
  "devices",
  "capability-verification",
  "first-goal",
  "live-overview",
] as const;

export type WorkspaceJourneyStep = (typeof WORKSPACE_JOURNEY_STEPS)[number];

/** The closed per-step states (honest; never a guessed success). */
export const WORKSPACE_JOURNEY_STEP_STATES = [
  "complete",
  "waiting",
  "action-needed",
  "blocked",
  "not-started",
  "not-available",
] as const;

export type WorkspaceJourneyStepState = (typeof WORKSPACE_JOURNEY_STEP_STATES)[number];

const STEP_LANGUAGE: Readonly<
  Record<WorkspaceJourneyStep, { readonly label: string; readonly explanation: string }>
> = Object.freeze({
  workspace: {
    label: "Workspace",
    explanation: "Your organization's workspace in RoamLink.",
  },
  "organization-verification": {
    label: "Organization verification",
    explanation: "RoamLink verified your organization before anything goes live.",
  },
  policy: {
    label: "Policy",
    explanation: "The connectivity rules your organization set for its people.",
  },
  connector: {
    label: "Connector",
    explanation: "The bridge that brings your organization's devices into RoamLink.",
  },
  devices: {
    label: "Devices",
    explanation: "The device fleet RoamLink helps on.",
  },
  "capability-verification": {
    label: "Capability verification",
    explanation: "What each device can actually do, verified - never assumed.",
  },
  "first-goal": {
    label: "First goal",
    explanation: "The first connectivity goal your organization set.",
  },
  "live-overview": {
    label: "Live organization overview",
    explanation: "Connectivity facts for the whole organization, read live.",
  },
});

const STEP_STATE_LANGUAGE: Readonly<Record<WorkspaceJourneyStepState, string>> = Object.freeze({
  complete: "Complete",
  waiting: "Waiting",
  "action-needed": "Action needed",
  blocked: "Blocked",
  "not-started": "Not started",
  "not-available": "Not available yet",
});

export interface WorkspaceJourneyStepView {
  readonly step: WorkspaceJourneyStep;
  readonly state: WorkspaceJourneyStepState;
  readonly fact: string;
}

/**
 * Derives the guided journey from the parsed read models. Pure + total.
 * Commercial, connectivity and journey vocabularies stay separate; no
 * step invents a success the reads do not assert.
 */
export function deriveWorkspaceJourney(input: {
  readonly session: ActorSessionResource;
  readonly workspace: EnterpriseWorkspaceResource;
  readonly devices: readonly DeviceResource[];
  readonly intents: readonly ExperienceIntentResource[];
  readonly connectivity: ConnectivityOverviewResource;
}): readonly WorkspaceJourneyStepView[] {
  const enrollment = input.workspace.enrollment;
  const connector = input.workspace.connector;

  const enrollmentState: WorkspaceJourneyStepState =
    enrollment === null
      ? "not-started"
      : enrollment.state === "active" || enrollment.state === "verified"
        ? "complete"
        : enrollment.state === "submitted"
          ? "waiting"
          : enrollment.state === "draft"
            ? "action-needed"
            : "blocked";

  const connectorState: WorkspaceJourneyStepState =
    connector === null
      ? "not-started"
      : connector.state === "provisioned"
        ? "complete"
        : connector.state === "provisioning"
          ? "waiting"
          : "blocked";

  const freshDevices = input.devices.filter(
    (device) => device.capabilityFreshness?.freshnessState === "FRESH",
  );
  const capabilityState: WorkspaceJourneyStepState =
    input.devices.length === 0
      ? "not-started"
      : freshDevices.length > 0
        ? "complete"
        : "waiting";

  const activeGoal = input.intents.find(
    (intent) => intent.status === "active" && intent.currentVersion?.status === "active",
  );
  const shellState = deriveShellConnectivityState(input.connectivity.subjects);
  const overviewState: WorkspaceJourneyStepState =
    shellState === "evidenced-fresh"
      ? "complete"
      : shellState === "no-reference"
        ? "action-needed"
        : "waiting";

  return [
    {
      step: "workspace",
      state: "complete",
      fact: `Signed in to ${input.workspace.organization?.name ?? input.session.tenantId} as ${input.session.role ?? input.session.scope}.`,
    },
    {
      step: "organization-verification",
      state: enrollmentState,
      fact:
        enrollment === null
          ? "No organization verification journey has been recorded yet."
          : enrollment.state === "active"
            ? `Organization verified and activated${enrollment.activatedAt === undefined ? "" : ` on ${enrollment.activatedAt}`}.`
            : enrollment.state === "verified"
              ? "Organization verified - activation is the remaining step."
              : enrollment.state === "submitted"
                ? "Organization verification was submitted and is being processed."
                : enrollment.state === "draft"
                  ? "The organization verification journey was started but not submitted yet."
                  : enrollment.state === "rejected"
                    ? `Organization verification was rejected${enrollment.rejectionReason === undefined ? "" : ` (${enrollment.rejectionReason})`}.`
                    : "The organization verification journey was cancelled.",
    },
    {
      // HONEST GAP: no org-policy read model exists in the application
      // contract yet. The page renders the not-yet-available state and
      // lists the gap - it never invents a policy summary.
      step: "policy",
      state: "not-available",
      fact: "A organization policy summary is not available yet. RoamLink will surface it here once the workspace exposes it.",
    },
    {
      step: "connector",
      state: connectorState,
      fact:
        connector === null
          ? "No connector has been set up for this workspace yet."
          : connector.state === "provisioned"
            ? `Connector provisioned${connector.provisionedAt === undefined ? "" : ` on ${connector.provisionedAt}`}.`
            : connector.state === "provisioning"
              ? "The connector is provisioning."
              : connector.state === "failed"
                ? `Connector provisioning failed${connector.failureReason === undefined ? "" : ` (${connector.failureReason})`}.`
                : "The connector was revoked.",
    },
    {
      step: "devices",
      state: input.devices.length === 0 ? "action-needed" : "complete",
      fact:
        input.devices.length === 0
          ? "No devices yet - enroll the fleet to bring the workspace live."
          : `${input.devices.length} device${input.devices.length === 1 ? "" : "s"} in the workspace fleet.`,
    },
    {
      step: "capability-verification",
      state: capabilityState,
      fact:
        input.devices.length === 0
          ? "Nothing to verify yet."
          : freshDevices.length === 0
            ? "No device has a fresh capability verification yet - RoamLink treats unverified abilities as unknown."
            : `${freshDevices.length} of ${input.devices.length} devices verified recently.`,
    },
    {
      step: "first-goal",
      state: activeGoal === undefined ? "action-needed" : "complete",
      fact:
        activeGoal === undefined
          ? "No goal is active yet - set the organization's first connectivity goal."
          : `Active: "${activeGoal.currentVersion?.rationale ?? "goal in progress"}".`,
    },
    {
      step: "live-overview",
      state: overviewState,
      fact: `${SHELL_CONNECTIVITY_LANGUAGE[shellState].label} — ${SHELL_CONNECTIVITY_LANGUAGE[shellState].detail}.`,
    },
  ];
}

// ---------------------------------------------------------------------------------
// Sections (spec/ux-architecture.md §12 L222-229)
// ---------------------------------------------------------------------------------

function workspaceSwitcherSection(
  session: ActorSessionResource,
  workspace: EnterpriseWorkspaceResource,
): HtmlFragment {
  const organization = workspace.organization;
  return el(
    "section",
    { class: "panel", "data-workspace-switcher": "true" },
    fragment(
      el("h3", {}, text("Workspace")),
      organization === null
        ? el(
            "p",
            { class: "muted", "data-workspace-org-unknown": "true" },
            text("RoamLink could not compose your organization identity for this workspace."),
          )
        : el(
            "p",
            {},
            fragment(
              text(`${organization.name} — `),
              stateBadge(organization.status),
              text(` (${session.scope} scope${session.role === null ? "" : `, role ${session.role}`})`),
            ),
          ),
      el(
        "p",
        { class: "muted", "data-workspace-switch-note": "true" },
        text(
          "Switching between several workspaces is not available yet. Your account is currently scoped to this single workspace.",
        ),
      ),
    ),
  );
}

function journeySection(steps: readonly WorkspaceJourneyStepView[]): HtmlFragment {
  return el(
    "section",
    { "data-workspace-journey": "true" },
    fragment(
      pageHeading(
        "Your workspace journey",
        "Set your organization up step by step — each step confirms from real state, never from a guess.",
      ),
      el(
        "ol",
        { class: "journey", "aria-label": "The enterprise onboarding journey, step by step" },
        ...steps.map((step) =>
          el(
            "li",
            {
              class: "journey-stage",
              "data-workspace-step": step.step,
              "data-workspace-step-state": step.state,
            },
            fragment(
              el(
                "p",
                { class: "journey-headline" },
                fragment(
                  el("strong", {}, text(STEP_LANGUAGE[step.step].label)),
                  text(" — "),
                  el(
                    "span",
                    { class: "journey-state", "data-state-word": step.state },
                    text(STEP_STATE_LANGUAGE[step.state]),
                  ),
                ),
              ),
              el("p", { class: "muted" }, text(STEP_LANGUAGE[step.step].explanation)),
              el("p", { class: "journey-fact" }, text(step.fact)),
            ),
          ),
        ),
      ),
    ),
  );
}

function orgConnectivitySection(connectivity: ConnectivityOverviewResource): HtmlFragment {
  const shellState = deriveShellConnectivityState(connectivity.subjects);
  return el(
    "section",
    { "data-org-connectivity": "true", "data-shell-state": shellState },
    fragment(
      pageHeading(
        "Organization connectivity",
        "Read from the same authoritative connectivity read as every other page — the workspace adds no second source of truth.",
      ),
      el(
        "p",
        { class: "muted" },
        fragment(
          text(SHELL_CONNECTIVITY_LANGUAGE[shellState].label),
          text(` — ${SHELL_CONNECTIVITY_LANGUAGE[shellState].detail}. Presented at ${connectivity.presentedAt}.`),
        ),
      ),
      connectivity.subjects.length === 0
        ? el(
            "p",
            { class: "muted", "data-org-connectivity-empty": "true" },
            text("No connectivity references exist for this workspace yet."),
          )
        : fragment(...connectivity.subjects.map((subject) => connectivitySubjectCard(subject))),
      el("p", {}, el("a", { href: pagePath("connectivity") }, text("Open the Connectivity center"))),
    ),
  );
}

function policySummarySection(): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-policy-summary": "not-available" },
    fragment(
      el("h3", {}, text("Policy summary")),
      el(
        "p",
        { class: "muted", "data-policy-gap": "true" },
        text(
          "Not available yet: the workspace does not expose an organization policy read yet. When it does, the summary appears here — nothing is invented in the meantime.",
        ),
      ),
    ),
  );
}

function deviceFleetSection(devices: readonly DeviceResource[]): HtmlFragment {
  return el(
    "section",
    { "data-device-fleet": "true" },
    fragment(
      pageHeading("Device fleet", "Every device in the workspace, with its verification freshness."),
      devices.length === 0
        ? el(
            "p",
            { class: "muted", "data-fleet-empty": "true" },
            text("No devices enrolled yet. Devices join the workspace to receive RoamLink's help."),
          )
        : el(
            "ul",
            { class: "goal-list", "data-fleet": "true", "aria-label": "Workspace device fleet" },
            ...devices.map((device) =>
              el(
                "li",
                { class: "goal-card", "data-fleet-device": device.deviceId, "data-device-status": device.status },
                fragment(
                  el(
                    "p",
                    {},
                    el("a", { href: pagePath("device", { deviceId: device.deviceId }) }, text(device.name)),
                  ),
                  el(
                    "p",
                    { class: "muted" },
                    fragment(
                      text("Capability verification: "),
                      freshnessBadge(device.capabilityFreshness),
                    ),
                  ),
                  el("p", {}, stateBadge(device.status)),
                ),
              ),
            ),
          ),
      el("p", {}, el("a", { href: pagePath("devices") }, text("Manage devices"))),
    ),
  );
}

function activeGoalsSection(intents: readonly ExperienceIntentResource[]): HtmlFragment {
  const active = intents.filter((intent) => intent.status === "active");
  return el(
    "section",
    { "data-workspace-goals": "true" },
    fragment(
      pageHeading("Active goals", "What the organization wants its connectivity to do."),
      active.length === 0
        ? el(
            "p",
            { class: "muted", "data-workspace-goals-empty": "true" },
            text("No active goals yet. A goal tells RoamLink what a good connection looks like for your devices."),
          )
        : el(
            "ul",
            { class: "goal-list", "aria-label": "Active goals" },
            ...active.map((intent) =>
              el(
                "li",
                { class: "goal-card", "data-goal-id": intent.intentId },
                fragment(
                  el(
                    "p",
                    {},
                    text(
                      intent.currentVersion === null
                        ? "Goal (not described yet)"
                        : intent.currentVersion.rationale,
                    ),
                  ),
                  el(
                    "p",
                    {},
                    el("a", { href: pagePath("intent", { intentId: intent.intentId }) }, text("Open this goal")),
                  ),
                ),
              ),
            ),
          ),
      el("p", {}, el("a", { href: pagePath("intents") }, text("Manage goals"))),
    ),
  );
}

function enrollmentSection(workspace: EnterpriseWorkspaceResource): HtmlFragment {
  const enrollment = workspace.enrollment;
  const connector = workspace.connector;
  return el(
    "section",
    { class: "panel", "data-workspace-enrollment": "true" },
    fragment(
      el("h3", {}, text("Connector and enrollment status")),
      enrollment === null
        ? el(
            "p",
            { class: "muted", "data-enrollment-absent": "true" },
            text("No organization verification journey has been recorded for this workspace yet."),
          )
        : el(
            "p",
            {},
            fragment(
              text("Organization verification: "),
              stateBadge(enrollment.state),
              text(` — ${enrollment.organizationName} (${enrollment.enrollmentId})`),
              enrollment.activatedAt === undefined
                ? fragment()
                : text(` — activated ${enrollment.activatedAt}`),
            ),
          ),
      connector === null
        ? el(
            "p",
            { class: "muted", "data-connector-absent": "true" },
            text("No connector has been set up yet."),
          )
        : el(
            "p",
            {},
            fragment(
              text("Connector: "),
              stateBadge(connector.state),
              text(` — ${connector.provisioningId}`),
            ),
          ),
    ),
  );
}

function activityAuditSection(): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-workspace-activity": "true" },
    fragment(
      el("h3", {}, text("Activity and audit")),
      el(
        "p",
        {},
        text("Everything RoamLink does for the organization is explained in Activity, with reasons and evidence."),
      ),
      el("p", {}, el("a", { href: pagePath("activity") }, text("Open Activity"))),
      el(
        "p",
        { class: "muted", "data-audit-note": "true" },
        text(
          "The operational audit trail lives in your organization's admin operations surface, not in customer navigation.",
        ),
      ),
    ),
  );
}

export function workspacePage(input: WorkspacePageInput): HtmlFragment {
  const steps = deriveWorkspaceJourney(input);
  const shellState = deriveShellConnectivityState(input.connectivity.subjects);
  // The workspace support escape pre-carries the same facts the page
  // renders: the connectivity subjects plus the devices whose capability
  // verification is not fresh. No invented references.
  const degradedDevices = input.devices.filter(
    (device) => device.capabilityFreshness?.freshnessState !== "FRESH",
  );
  return fragment(
    pageHeading(
      "Workspace",
      "Your organization's live view of RoamLink — guided setup, fleet, goals and connectivity, all read from the same authoritative sources.",
    ),
    workspaceSwitcherSection(input.session, input.workspace),
    journeySection(steps),
    orgConnectivitySection(input.connectivity),
    policySummarySection(),
    deviceFleetSection(input.devices),
    activeGoalsSection(input.intents),
    enrollmentSection(input.workspace),
    activityAuditSection(),
    el(
      "section",
      { class: "panel", "data-workspace-support": "true" },
      fragment(
        el("h3", {}, text("Support")),
        shellState === "evidenced-fresh" && degradedDevices.length === 0
          ? el(
              "p",
              { class: "muted" },
              text("Everything looks healthy right now. Support is always here if that changes."),
            )
          : supportEscape({
              context: {
                subject: "Our organization workspace shows a degraded state we need help with.",
                detail: `Connectivity reads: ${SHELL_CONNECTIVITY_LANGUAGE[shellState].label} — ${SHELL_CONNECTIVITY_LANGUAGE[shellState].detail}.`,
                refs: [
                  ...input.connectivity.subjects.map((subject) => ({
                    kind: subject.subjectType,
                    id: subject.subjectId,
                  })),
                  ...degradedDevices.map((device) => ({
                    kind: "device" as const,
                    id: device.deviceId,
                  })),
                ],
              },
            }),
      ),
    ),
  );
}
