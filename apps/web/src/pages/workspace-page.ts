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
 * PA-06 (RL-115-F3): the connector journey step is now the GUIDED ACTION.
 * The connector enrollment flow section composes the customer command
 * (provision-connector through @roamlink/app-kit's mirrored contract) and
 * renders every stage FROM THE READ MODEL ONLY:
 *
 *   Not started -> [Start enrollment] (command; capability-gated) ->
 *   Provisioning (honest in-flight) -> Verification -> Provisioned
 *
 * with the failure path (failure reason vocabulary, honest) -> [Retry] /
 * Support escape. The page holds NO enrollment state machine: the
 * enterprise package's transition machinery owns every state change
 * (composed through the command envelope + the workspace read, never
 * copied - the step/flow derivations below are pure functions over the
 * parsed reads).
 *
 * Honest-by-construction:
 *  - every journey step renders one of the closed states (complete /
 *    waiting / action-needed / blocked / not-started / not-available);
 *  - the enterprise read contract (enrollment/connector/policy) arrives
 *    through @roamlink/app-kit's mirrored vocabularies - never a direct
 *    enterprise dependency, never a redefined state;
 *  - PA-007 (closes RL-115-F7): the policy journey step and the policy
 *    summary section render from the READ MODEL - the current policy
 *    record (source, version, freshness) or the EXPLICIT absence states
 *    (not-configured / unknown / not-available). The absence is a contract
 *    state now, never a UI shrug; and the page stays READ-ONLY: policy is
 *    organization-level configuration managed upstream, so the section's
 *    user action names where management lives, it never offers a policy
 *    editor (RoamLink creates no second policy authority);
 *  - PA-008 (closes RL-115-F5): the enterprise integrations section renders
 *    the SSO/SCIM/MDM statuses from the READ MODEL - each integration
 *    distinguishes EXACTLY four honest states (configured / not-configured
 *    / unavailable / unknown). A missing backend contract is represented
 *    HONESTLY: `unavailable` renders "requires the enterprise integration
 *    API" with an explanation, never a fabricated configuration control -
 *    no OAuth dance, no SCIM endpoint fields, no MDM enrollment forms
 *    exist on this surface (the section composes no form, button or
 *    command flow at all). Integrations are organization-level
 *    configuration managed by the organization's own identity/device
 *    infrastructure, so the section stays READ-ONLY and its user action
 *    names where management lives; a workspace composing no integrations
 *    read degrades honestly (every kind renders the honest unavailable
 *    state + the support escape);
 *  - sections the API does not yet expose (cross-workspace switching; the
 *    audit trail surface) render the honest not-yet-available state
 *    instead of invented content;
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
  ENTERPRISE_INTEGRATION_RESOURCE_KINDS,
  SHELL_CONNECTIVITY_LANGUAGE,
  freshnessBadge,
  mutationStages,
  stateBadge,
  el,
  fragment,
  text,
  type ActorSessionResource,
  type ConnectivityOverviewResource,
  type DeviceResource,
  type EnterpriseConnectorFailureResourceReason,
  type EnterpriseIntegrationResourceKind,
  type EnterpriseIntegrationResourceState,
  type EnterpriseIntegrationView,
  type EnterprisePolicyView,
  type EnterpriseWorkspaceResource,
  type ExperienceIntentResource,
  type FreshnessView,
  type HtmlFragment,
  type MutationAcknowledgement,
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
  /**
   * PA-06: the provision-connector command acknowledgement (the polling
   * status read via the `commandId` page param). Absent renders no
   * pipeline - the flow never fabricates a command record from reads.
   */
  readonly command?: MutationAcknowledgement;
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
  /**
   * PA-06: the step's contextual action affordance (rendered as an
   * in-page anchor). The connector step carries the link to the guided
   * connector enrollment flow below - the §15 contextual link from the
   * journey where the capability becomes relevant.
   */
  readonly action?: { readonly href: string; readonly label: string };
}

/**
 * PA-06: the connector-start gates, derived ONLY from the read models.
 *
 * The command's server-side preconditions made visible honestly: the
 * provisioning belongs to the enterprise ENROLLMENT journey (a verified or
 * active organization), and it is an organization-admin action (the
 * org:manage permission the API enforces). When a gate fails, the step
 * renders the honest explanation - never a dead action.
 */
export function connectorStartGates(input: {
  readonly session: ActorSessionResource;
  readonly workspace: EnterpriseWorkspaceResource;
}): { readonly enrollmentVerified: boolean; readonly actorCanManage: boolean } {
  const enrollment = input.workspace.enrollment;
  const enrollmentVerified =
    enrollment !== null && (enrollment.state === "verified" || enrollment.state === "active");
  const actorCanManage = input.session.permissions.includes("org:manage");
  return { enrollmentVerified, actorCanManage };
}

/**
 * PA-007 (closes RL-115-F7): the closed policy-summary render states. The
 * three record states (configured / not-configured / unknown) mirror the
 * app-kit policy vocabulary verbatim; `not-available` is the honest null
 * section (this workspace composes no policy read). The absence states
 * stay SEPARATE - never collapsed, never a guess.
 */
export const POLICY_SUMMARY_RENDER_STATES = [
  "configured",
  "not-configured",
  "unknown",
  "not-available",
] as const;

export type PolicySummaryRenderState = (typeof POLICY_SUMMARY_RENDER_STATES)[number];

/** The policy summary derivation (the step + the section share it). */
export interface PolicySummaryView {
  readonly state: PolicySummaryRenderState;
  /** The journey step state this policy state derives to (honest). */
  readonly stepState: WorkspaceJourneyStepState;
  readonly fact: string;
  readonly policy: EnterprisePolicyView | null;
}

/**
 * Derives the policy summary from the workspace read's policy section.
 * Pure + total over every shape-legal wire world; no world invents a
 * policy, and the freshness is carried (never collapsed):
 *  - `configured` + FRESH -> complete (the policy, its source, version and
 *    freshness all render);
 *  - `configured`/`not-configured` + STALE -> waiting (the assertion
 *    renders FROM the last verified read, paired with its stale freshness
 *    - the same evidence-freshness language the live-overview step uses);
 *  - `not-configured` + FRESH -> action-needed (the action lives upstream:
 *    the organization's administration configures policy, never RoamLink);
 *  - `unknown` (or an evidence-less record) -> waiting on the first
 *    verified observation (absence of evidence, never a guess);
 *  - null section -> not-available (the workspace composes no policy read).
 */
export function derivePolicySummary(policy: EnterprisePolicyView | null): PolicySummaryView {
  if (policy === null) {
    return {
      state: "not-available",
      stepState: "not-available",
      fact: "An organization policy read is not available for this workspace yet. RoamLink will surface the summary here once the workspace exposes it.",
      policy,
    };
  }
  const freshness = policy.freshness.freshnessState;
  if (policy.state === "configured") {
    const statement =
      policy.summary === undefined ? "the current policy" : `"${policy.summary}"`;
    const version =
      policy.policyVersion === undefined ? "" : ` (version ${policy.policyVersion})`;
    return {
      state: "configured",
      stepState: freshness === "FRESH" ? "complete" : "waiting",
      fact:
        freshness === "FRESH"
          ? `Organization policy in effect: ${statement}${version}.`
          : freshness === "STALE"
            ? `Organization policy in effect as of the last verified read: ${statement}${version} — the read is stale.`
            : "A policy statement exists but no verified policy observation backs it yet.",
      policy,
    };
  }
  if (policy.state === "not-configured") {
    return {
      state: "not-configured",
      stepState: freshness === "FRESH" ? "action-needed" : "waiting",
      fact:
        freshness === "FRESH"
          ? "No organization policy is configured yet — your organization's administrators set its connectivity rules upstream."
          : freshness === "STALE"
            ? "No organization policy was configured as of the last verified read — the read is stale."
            : "No verified policy observation exists yet — whether a policy is configured is unknown.",
      policy,
    };
  }
  return {
    state: "unknown",
    stepState: "waiting",
    fact: "No verified policy observation exists yet — whether a policy is configured is unknown.",
    policy,
  };
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
  const gates = connectorStartGates(input);
  const connectorGatesPass = gates.enrollmentVerified && gates.actorCanManage;
  const policySummary = derivePolicySummary(input.workspace.policy);

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
      ? connectorGatesPass
        ? "action-needed"
        : "not-started"
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
      // PA-007 (closes RL-115-F7): the policy step renders from the read
      // model - the current policy record with its freshness, or one of
      // the EXPLICIT absence states (not-configured / unknown /
      // not-available). The absence is a contract state now, never a UI
      // shrug; the section below carries the full summary.
      step: "policy",
      state: policySummary.stepState,
      fact: policySummary.fact,
      action: { href: "#policy-summary", label: "Review the policy summary" },
    },
    {
      step: "connector",
      state: connectorState,
      fact:
        connector === null
          ? connectorGatesPass
            ? "No connector has been set up for this workspace yet. Start the connector enrollment below."
            : "No connector has been set up for this workspace yet. Organization verification comes first."
          : connector.state === "provisioned"
            ? `Connector provisioned${connector.provisionedAt === undefined ? "" : ` on ${connector.provisionedAt}`}.`
            : connector.state === "provisioning"
              ? "The connector is provisioning."
              : connector.state === "failed"
                ? `Connector provisioning failed${connector.failureReason === undefined ? "" : ` (${connector.failureReason})`}.`
                : "The connector was revoked.",
      action: {
        href: "#connector-enrollment",
        label:
          connector === null
            ? connectorGatesPass
              ? "Start connector enrollment"
              : "Review the connector steps"
            : "Review the connector enrollment",
      },
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
              step.action === undefined
                ? fragment()
                : el(
                    "p",
                    { class: "journey-action" },
                    el("a", { href: step.action.href }, text(step.action.label)),
                  ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------
// PA-06: the guided connector enrollment flow (RL-115-F3 — "status but no
// action" closed). The journey step points here; every stage below is a PURE
// DERIVATION over the same workspace read — the page holds no enrollment
// state machine, and the only writer is the provision-connector command
// through the app contract (the enterprise package's transition machinery
// owns every state change).
// ---------------------------------------------------------------------------------

/** The closed guided connector-enrollment flow stages, in journey order. */
export const CONNECTOR_ENROLLMENT_FLOW_STAGES = [
  "not-started",
  "provisioning",
  "verification",
  "provisioned",
] as const;

export type ConnectorEnrollmentFlowStage =
  (typeof CONNECTOR_ENROLLMENT_FLOW_STAGES)[number];

/** The closed per-stage render states (honest; never a guessed success). */
export const CONNECTOR_FLOW_STAGE_STATES = [
  "complete",
  "current",
  "upcoming",
  "action-needed",
  "failed",
  "revoked",
] as const;

export type ConnectorFlowStageState = (typeof CONNECTOR_FLOW_STAGE_STATES)[number];

const CONNECTOR_FLOW_STAGE_LANGUAGE: Readonly<
  Record<ConnectorEnrollmentFlowStage, { readonly label: string; readonly explanation: string }>
> = Object.freeze({
  "not-started": {
    label: "Not started",
    explanation: "No connector is set up for this workspace yet.",
  },
  provisioning: {
    label: "Provisioning",
    explanation:
      "RoamLink prepares the connector; the live record drives this page, never a guess.",
  },
  verification: {
    label: "Verification",
    explanation:
      "RoamLink verifies the provisioned connector against your verified organization before the record may say it is ready.",
  },
  provisioned: {
    label: "Provisioned",
    explanation: "The connector is set up and ready to bring your organization's devices in.",
  },
});

const CONNECTOR_FLOW_STAGE_STATE_LANGUAGE: Readonly<Record<ConnectorFlowStageState, string>> =
  Object.freeze({
    complete: "Complete",
    current: "In progress",
    upcoming: "Not yet",
    "action-needed": "Action needed",
    failed: "Failed",
    revoked: "Revoked",
  });

/** The closed failure-reason vocabulary, explained honestly (spec §14: never a bare code). */
const CONNECTOR_FAILURE_LANGUAGE: Readonly<
  Record<string, { readonly sentence: string }>
> = Object.freeze({
  "connector-unavailable": {
    sentence: "the connector service was not available to take the enrollment",
  },
  "capability-negotiation-empty": {
    sentence: "no capability could be negotiated for this connector",
  },
  "configuration-delivery-failed": {
    sentence: "the connector's configuration could not be delivered",
  },
});

export interface ConnectorEnrollmentStageView {
  readonly stage: ConnectorEnrollmentFlowStage;
  readonly state: ConnectorFlowStageState;
  readonly fact: string;
}

/**
 * Derives the guided connector-enrollment flow from the read models.
 * Pure + total; no step invents a success the reads do not assert:
 *  - `not-started` is action-needed ONLY when both start gates pass
 *    (verified/active enrollment + the org:manage permission the API
 *    enforces) — otherwise it renders the honest gate explanation;
 *  - `provisioning` is current only while the record says provisioning
 *    (the honest in-flight state — nothing is claimed as ready);
 *  - `verification` renders the organization verification the enrollment
 *    rides on (the enrollment's own verified state + instant — the read
 *    model's verification facts, never an invented connector sub-state);
 *  - `provisioned` is complete only when the record says provisioned.
 */
export function deriveConnectorEnrollmentFlow(input: {
  readonly session: ActorSessionResource;
  readonly workspace: EnterpriseWorkspaceResource;
}): readonly ConnectorEnrollmentStageView[] {
  const connector = input.workspace.connector;
  const enrollment = input.workspace.enrollment;
  const gates = connectorStartGates(input);
  const gatesPass = gates.enrollmentVerified && gates.actorCanManage;

  const notStartedFact = gatesPass
    ? "No connector is set up yet. Start the enrollment below — you name the connector, and RoamLink records every step as it happens."
    : !gates.enrollmentVerified
      ? "Organization verification comes first — the connector enrollment rides on a verified organization."
      : "Connector enrollment is an organization-admin action — an owner or admin of your organization starts it.";

  return [
    {
      stage: "not-started",
      state: connector === null ? (gatesPass ? "action-needed" : "current") : "complete",
      fact: notStartedFact,
    },
    {
      stage: "provisioning",
      state:
        connector === null
          ? "upcoming"
          : connector.state === "provisioning"
            ? "current"
            : connector.state === "failed"
              ? "failed"
              : "complete",
      fact:
        connector === null
          ? "Provisioning starts when you start the enrollment."
          : connector.state === "provisioning"
            ? "The connector is provisioning. Nothing is claimed as ready before the record says so."
            : connector.state === "failed"
              ? `Provisioning failed${connector.failureReason === undefined ? "" : ` — ${connector.failureReason}`}.`
              : connector.state === "revoked"
                ? connector.provisionedAt === undefined
                  ? "The provisioning was revoked before it completed."
                  : "The connector was provisioned and later revoked."
                : "Provisioning finished.",
    },
    {
      stage: "verification",
      state:
        connector === null || connector.state === "failed"
          ? "upcoming"
          : connector.state === "provisioning"
            ? "current"
            : connector.state === "revoked" && connector.provisionedAt === undefined
              ? "upcoming"
              : "complete",
      fact:
        connector !== null && connector.state === "provisioned"
          ? `Verification passed — the record is provisioned${
              enrollment?.verifiedAt === undefined ? "" : ` against your organization's verification (recorded ${enrollment.verifiedAt})`
            }.`
          : connector !== null && connector.state === "provisioning"
            ? `RoamLink is verifying the provisioned connector against your organization${
                enrollment?.verifiedAt === undefined ? "" : ` (verification recorded ${enrollment.verifiedAt})`
              }.`
            : "Verification happens between provisioning and the ready record — the connector rides on your organization's verification.",
    },
    {
      stage: "provisioned",
      state:
        connector === null
          ? "upcoming"
          : connector.state === "provisioned"
            ? "complete"
            : connector.state === "revoked"
              ? "revoked"
              : "upcoming",
      fact:
        connector !== null && connector.state === "provisioned"
          ? `The connector is set up and ready${connector.provisionedAt === undefined ? "" : ` (recorded ${connector.provisionedAt})`}.`
          : connector !== null && connector.state === "revoked"
            ? "The connector was revoked — there is no active connector for this workspace."
            : "The connector is ready once verification passes and the record says provisioned.",
    },
  ];
}

/** The [Start enrollment] / [Retry enrollment] command form (the ONLY writer). */
function connectorStartForm(input: { readonly label: string }): HtmlFragment {
  return el(
    "form",
    {
      method: "post",
      action: "/flows/provision-connector",
      "data-flow": "provision-connector",
    },
    el("label", { for: "connector-label" }, text("Name this connector")),
    el("input", {
      type: "text",
      name: "connectorId",
      id: "connector-label",
      required: true,
      pattern: "[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}",
      "aria-describedby": "connector-label-hint",
    }),
    el(
      "p",
      { class: "muted", id: "connector-label-hint" },
      text("A short label for your own reference — letters, numbers, dots, dashes. Never a password or key."),
    ),
    el("button", { type: "submit" }, text(input.label)),
  );
}

/** The failure explanation: the closed reason vocabulary, honest, plus retry + support. */
function connectorFailurePanel(input: {
  readonly provisioningId: string;
  readonly failureReason: EnterpriseConnectorFailureResourceReason | undefined;
}): HtmlFragment {
  const reason = input.failureReason;
  const language = reason === undefined ? undefined : CONNECTOR_FAILURE_LANGUAGE[reason];
  return el(
    "div",
    { class: "panel error", "data-connector-failure": "true" },
    fragment(
      el("h3", {}, text("Connector enrollment failed")),
      el(
        "p",
        {},
        fragment(
          text("Reason recorded: "),
          reason === undefined ? fragment() : fragment(stateBadge(reason), text(" — ")),
          text(
            reason === undefined
              ? "not recorded — the failure carried no recorded reason."
              : `${language?.sentence ?? "the failure carried a recorded reason from the closed vocabulary"}.`,
          ),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text("A failed attempt is kept as a record. Starting again creates a new attempt — nothing is carried over silently."),
      ),
      connectorStartForm({ label: "Retry enrollment" }),
      supportEscape({
        context: {
          subject: "Our organization's connector enrollment failed and we need help.",
          detail: `Provisioning ${input.provisioningId} failed${
            reason === undefined ? "" : ` with the recorded reason ${reason}`
          }. We would like help getting the connector enrolled.`,
          refs: [],
        },
      }),
    ),
  );
}

function connectorEnrollmentSection(
  session: ActorSessionResource,
  workspace: EnterpriseWorkspaceResource,
  command: MutationAcknowledgement | undefined,
): HtmlFragment {
  const connector = workspace.connector;
  const gates = connectorStartGates({ session, workspace });
  const gatesPass = gates.enrollmentVerified && gates.actorCanManage;
  const stages = deriveConnectorEnrollmentFlow({ session, workspace });
  return el(
    "section",
    { id: "connector-enrollment", "data-connector-enrollment": "true" },
    fragment(
      pageHeading(
        "Connector enrollment",
        "Bring your organization's devices into RoamLink through a connector. Each step below confirms from the live record — never from a guess.",
      ),
      el(
        "ol",
        { class: "journey", "aria-label": "The connector enrollment flow, step by step" },
        ...stages.map((stage) =>
          el(
            "li",
            {
              class: "journey-stage",
              "data-connector-flow-stage": stage.stage,
              "data-stage-state": stage.state,
            },
            fragment(
              el(
                "p",
                { class: "journey-headline" },
                fragment(
                  el("strong", {}, text(CONNECTOR_FLOW_STAGE_LANGUAGE[stage.stage].label)),
                  text(" — "),
                  el(
                    "span",
                    { class: "journey-state", "data-stage-word": stage.state },
                    text(CONNECTOR_FLOW_STAGE_STATE_LANGUAGE[stage.state]),
                  ),
                ),
              ),
              el(
                "p",
                { class: "muted" },
                text(CONNECTOR_FLOW_STAGE_LANGUAGE[stage.stage].explanation),
              ),
              el("p", { class: "journey-fact" }, text(stage.fact)),
            ),
          ),
        ),
      ),
      // The command affordance: ONLY when no connector exists AND both
      // start gates pass (the API re-checks both fail-closed; the UI gate
      // is honest UX, never the authority).
      connector === null && gatesPass
        ? el(
            "div",
            { class: "panel", "data-connector-start": "true" },
            connectorStartForm({ label: "Start enrollment" }),
          )
        : fragment(),
      // The honest gate renders (why no start action exists here).
      connector === null && !gates.enrollmentVerified
        ? el(
            "p",
            { class: "muted", "data-connector-gate": "enrollment" },
            text("No start action is offered yet: the connector enrollment rides on a verified organization, and this workspace's verification journey has not reached that state."),
          )
        : fragment(),
      connector === null && gates.enrollmentVerified && !gates.actorCanManage
        ? el(
            "p",
            { class: "muted", "data-connector-gate": "permission" },
            text("Connector enrollment is an organization-admin action. An owner or admin of your organization starts it — the steps above show exactly what will happen."),
          )
        : fragment(),
      // The honest in-flight state + the polling affordances (the re-read
      // link, and the command pipeline when the host forwards commandId).
      connector !== null && connector.state === "provisioning"
        ? el(
            "div",
            { class: "panel", "data-connector-inflight": "true" },
            fragment(
              el("p", {}, text("The connector is provisioning.")),
              el(
                "p",
                { class: "muted" },
                text("This page reads the live record — nothing is claimed as ready before the record says provisioned."),
              ),
              el("p", {}, el("a", { href: pagePath("workspace") }, text("Refresh the connector state"))),
            ),
          )
        : fragment(),
      // The failure path: explanation + retry + support escape.
      connector !== null && connector.state === "failed"
        ? connectorFailurePanel({
            provisioningId: connector.provisioningId,
            failureReason: connector.failureReason,
          })
        : fragment(),
      // The revoked path: the honest terminal record + support escape.
      connector !== null && connector.state === "revoked"
        ? el(
            "div",
            { class: "panel", "data-connector-revoked": "true" },
            fragment(
              el("h3", {}, text("The connector was revoked")),
              el(
                "p",
                { class: "muted" },
                text("The workspace has no active connector. Support can help figure out what happened and what comes next."),
              ),
              supportEscape({
                context: {
                  subject: "Our organization's connector was revoked and we need help.",
                  detail: `Provisioning ${connector.provisioningId} is revoked. We would like help understanding what happened.`,
                  refs: [],
                },
              }),
            ),
          )
        : fragment(),
      // The command-status pipeline (the polling states' acknowledgement
      // read — rendered only when the host forwards the flow's commandId).
      command === undefined
        ? fragment()
        : el(
            "div",
            { class: "panel", "data-connector-command": "true", "data-command-id": command.commandId },
            fragment(
              el("h3", {}, text("Your enrollment command")),
              el(
                "p",
                { class: "muted" },
                text("The four stages stay separate on purpose — accepted is not executed, and this command is a setup action, not a delivery claim."),
              ),
              mutationStages(command),
            ),
          ),
      el(
        "p",
        { class: "muted", "data-connector-support-reachability": "true" },
        text("If the connector enrollment runs into trouble, Support is reachable from this page and the connector facts travel with the case."),
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

function policySummarySection(policy: EnterprisePolicyView | null): HtmlFragment {
  const view = derivePolicySummary(policy);
  const policyRecord = view.policy;
  return el(
    "section",
    { class: "panel", id: "policy-summary", "data-policy-summary": view.state },
    fragment(
      el("h3", {}, text("Policy summary")),
      // The state-dependent body: every world renders from the read model
      // only - the absence states are explicit contract states, never a
      // collapsed shrug (PA-007, closes RL-115-F7).
      view.state === "configured"
        ? el(
            "p",
            { "data-policy-statement": "true" },
            text(policyRecord?.summary ?? "The current organization policy."),
          )
        : fragment(),
      view.state === "configured"
        ? el(
            "p",
            {},
            fragment(
              text("Source: "),
              el(
                "span",
                { "data-policy-source": "true" },
                text(policyRecord?.source ?? ""),
              ),
              text(" — Version: "),
              el(
                "span",
                { "data-policy-version": "true" },
                text(policyRecord?.policyVersion ?? ""),
              ),
              text(
                policyRecord?.effectiveAt === undefined
                  ? ""
                  : ` — Effective: ${policyRecord.effectiveAt}`,
              ),
            ),
          )
        : fragment(),
      view.state === "not-configured"
        ? el(
            "p",
            { class: "muted", "data-policy-absent": "true" },
            text(
              "No organization policy is configured yet. Your organization's administrators set its connectivity rules upstream — none are in effect yet.",
            ),
          )
        : fragment(),
      view.state === "unknown"
        ? el(
            "p",
            { class: "muted", "data-policy-unknown": "true" },
            text(
              "The policy state is unknown — no verified policy observation exists yet. RoamLink renders nothing it cannot verify.",
            ),
          )
        : fragment(),
      view.state === "not-available"
        ? el(
            "p",
            { class: "muted", "data-policy-absent": "true" },
            text(
              "Not available yet: this workspace does not expose an organization policy read. When it does, the summary appears here — nothing is invented in the meantime.",
            ),
          )
        : fragment(),
      // The freshness pairing (§14: fresh/stale/unknown as text + visual
      // treatment): every present record carries its freshness beside the
      // statement - a stale read renders its content PAIRED with the stale
      // badge, never hidden, never silently trusted.
      policyRecord !== null
        ? el(
            "p",
            {},
            fragment(text("Policy read: "), freshnessBadge(policyRecord.freshness)),
          )
        : fragment(),
      // The authority note (the available user action, honestly bounded):
      // policy management lives UPSTREAM, in the organization's own
      // administration. RoamLink surfaces the record read-only - this
      // section offers no policy editor, because editing policy here would
      // create a second policy authority (the hard law this page obeys).
      el(
        "p",
        { class: "muted", "data-policy-authority": "true" },
        text(
          "Organization policy is managed by your organization's administrators upstream. RoamLink surfaces it here read-only — it never edits or enforces policy.",
        ),
      ),
      // The recovery path (§15): Support is reachable for policy questions.
      el(
        "p",
        { class: "muted", "data-policy-support-reachability": "true" },
        text("If the policy summary looks wrong or stale, Support is reachable from this workspace's Support section below."),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------
// PA-008 (closes RL-115-F5): the enterprise integrations section. SSO, SCIM
// and MDM finally have a visible surface — rendered FROM THE READ MODEL
// ONLY, exactly as bounded by the audit's candidate remediation: each
// integration distinguishes EXACTLY four honest states (Configured | Not
// configured | Unavailable | Unknown), and a missing backend contract is
// represented HONESTLY ("Unavailable — requires the enterprise integration
// API" + an explanation), never replaced with a fabricated configuration
// control. The section composes NO form, button or command flow: the UI
// never fabricates configuration capability (no OAuth dance, no SCIM
// endpoint fields, no MDM enrollment forms), because no write contract
// backs them. Enterprise integrations are organization-level configuration
// managed by the organization's own identity/device infrastructure — the
// section is READ-ONLY, like the policy summary.
// ---------------------------------------------------------------------------------

/**
 * The render order of the integration rows: the mirrored closed kind
 * vocabulary, verbatim (never redefined here — apps/web imports ONLY
 * app-kit's mirrored vocabularies).
 */
export const WORKSPACE_INTEGRATION_KINDS: readonly EnterpriseIntegrationResourceKind[] =
  ENTERPRISE_INTEGRATION_RESOURCE_KINDS;

/** The kind vocabulary in plain words (for the honest unavailable explanations). */
const INTEGRATION_LANGUAGE: Readonly<
  Record<EnterpriseIntegrationResourceKind, { readonly label: string; readonly plainName: string; readonly explanation: string }>
> = Object.freeze({
  sso: {
    label: "Single sign-on (SSO)",
    plainName: "single sign-on",
    explanation:
      "Your organization's people sign in with their existing work accounts instead of separate RoamLink passwords.",
  },
  scim: {
    label: "User provisioning (SCIM)",
    plainName: "user provisioning",
    explanation:
      "Your organization's directory would keep RoamLink membership in sync automatically.",
  },
  mdm: {
    label: "Device management (MDM)",
    plainName: "device management",
    explanation:
      "Your organization's device management would enroll and guide the fleet's devices.",
  },
});

/** The four honest states, as written words (§14: never state by color alone). */
const INTEGRATION_STATE_LANGUAGE: Readonly<Record<EnterpriseIntegrationResourceState, string>> =
  Object.freeze({
    configured: "Configured",
    "not-configured": "Not configured",
    unavailable: "Unavailable",
    unknown: "Unknown",
  });

/** One integration row, derived purely from the workspace read. */
export interface IntegrationRowView {
  readonly kind: EnterpriseIntegrationResourceKind;
  readonly state: EnterpriseIntegrationResourceState;
  readonly fact: string;
  /** The in-effect summary; present only on a configured row. */
  readonly summary?: string;
  /** The read's freshness; absent when no view was composed for the kind. */
  readonly freshness?: FreshnessView;
}

/** The honest "missing backend contract" sentence every unavailable row leads with. */
const UNAVAILABLE_LEAD = "Unavailable — requires the enterprise integration API.";

/**
 * Derives the integration rows from the workspace read's integrations
 * section. Pure + total over every shape-legal wire world; no world invents
 * an integration status, and the four states stay SEPARATE — never
 * collapsed, never a guess:
 *  - a `configured` view renders its summary with the freshness pairing
 *    (a stale read keeps its content PAIRED with the stale badge — the §14
 *    discipline);
 *  - a `not-configured` view renders the verified absence (the action
 *    lives upstream: the organization's administrators configure
 *    integrations, never RoamLink);
 *  - an `unavailable` view renders the honest missing-contract state —
 *    "requires the enterprise integration API" with the explanation, never
 *    a fabricated control;
 *  - an `unknown` view renders the absence of evidence (never a guess);
 *  - a kind the section does not carry renders the honest unavailable state
 *    (no status was composed for it — nothing is invented);
 *  - a NULL section (an older payload, or a workspace composing no
 *    integrations read) degrades honestly: every kind renders the honest
 *    unavailable state.
 */
export function deriveIntegrationRows(
  integrations: readonly EnterpriseIntegrationView[] | null,
): readonly IntegrationRowView[] {
  return WORKSPACE_INTEGRATION_KINDS.map((kind) => {
    const view = integrations?.find((candidate) => candidate.kind === kind);
    if (view === undefined) {
      return {
        kind,
        state: "unavailable" as const,
        fact:
          integrations === null
            ? `${UNAVAILABLE_LEAD} This workspace composes no integration status read yet; when it does, the real states appear here. Nothing is invented in the meantime.`
            : `${UNAVAILABLE_LEAD} This workspace's integration read carries no ${INTEGRATION_LANGUAGE[kind].plainName} status; when the read exists, the real state appears here. Nothing is invented in the meantime.`,
      };
    }
    const freshness = view.freshness.freshnessState;
    if (view.state === "configured") {
      const summary = view.summary ?? "the configured integration";
      return {
        kind,
        state: "configured" as const,
        fact:
          freshness === "FRESH"
            ? `In effect: "${summary}".`
            : freshness === "STALE"
              ? `In effect as of the last verified read: "${summary}" — the read is stale.`
              : "An integration record exists but no verified observation backs it yet.",
        ...(view.summary !== undefined ? { summary: view.summary } : {}),
        freshness: view.freshness,
      };
    }
    if (view.state === "not-configured") {
      return {
        kind,
        state: "not-configured" as const,
        fact:
          freshness === "FRESH"
            ? "Not configured — a verified observation confirms your organization has not set this up. Your organization's administrators configure it upstream, never RoamLink."
            : freshness === "STALE"
              ? "Not configured as of the last verified read — the read is stale."
              : "No verified observation exists yet — whether this integration is configured is unknown.",
        freshness: view.freshness,
      };
    }
    if (view.state === "unavailable") {
      return {
        kind,
        state: "unavailable" as const,
        fact: `${UNAVAILABLE_LEAD} RoamLink's enterprise integration API does not expose a ${INTEGRATION_LANGUAGE[kind].plainName} status read yet; when it does, the real state appears here. Nothing is invented in the meantime.`,
        freshness: view.freshness,
      };
    }
    return {
      kind,
      state: "unknown" as const,
      fact: "No verified observation exists yet — whether this integration is configured is unknown.",
      freshness: view.freshness,
    };
  });
}

function integrationsSection(integrations: readonly EnterpriseIntegrationView[] | null): HtmlFragment {
  const rows = deriveIntegrationRows(integrations);
  return el(
    "section",
    { id: "integrations", "data-integrations": "true" },
    fragment(
      pageHeading(
        "Enterprise integrations",
        "The single sign-on, user provisioning and device management integrations your organization can connect through RoamLink — every state below comes from the live read, never from a guess.",
      ),
      el(
        "ul",
        {
          class: "goal-list",
          "data-integration-rows": "true",
          "aria-label": "Enterprise integrations and their current states",
        },
        ...rows.map((row) =>
          el(
            "li",
            {
              class: "goal-card",
              "data-integration": row.kind,
              "data-integration-state": row.state,
            },
            fragment(
              el(
                "p",
                {},
                fragment(
                  el("strong", {}, text(INTEGRATION_LANGUAGE[row.kind].label)),
                  text(" — "),
                  el(
                    "span",
                    { class: "journey-state", "data-state-word": row.state },
                    text(INTEGRATION_STATE_LANGUAGE[row.state]),
                  ),
                ),
              ),
              el("p", { class: "muted" }, text(INTEGRATION_LANGUAGE[row.kind].explanation)),
              el("p", { class: "journey-fact" }, text(row.fact)),
              row.freshness === undefined
                ? fragment()
                : el(
                    "p",
                    {},
                    fragment(text("Integration read: "), freshnessBadge(row.freshness)),
                  ),
            ),
          ),
        ),
      ),
      // The authority note (the available user action, honestly bounded):
      // integration configuration lives UPSTREAM, with the organization's
      // administrators and its own identity/device infrastructure. This
      // section offers no configuration control, because composing one here
      // would fabricate capability no contract backs.
      el(
        "p",
        { class: "muted", "data-integrations-authority": "true" },
        text(
          "Enterprise integrations are managed by your organization's administrators and its own identity and device systems. RoamLink surfaces their status here read-only — it never configures, enrolls or authenticates an integration.",
        ),
      ),
      // The recovery path (§15). Where no read contract exists yet (any row
      // unavailable) or no verified observation exists (any row unknown),
      // the surface renders the honest state + THE SUPPORT ESCAPE — the
      // customer cannot see the real status there, so help must be one
      // reach away, with the statuses the read holds pre-carried in the
      // narrative (no invented references). When every row rests on a
      // verified observation, the quiet reachability note renders instead
      // (an escape is for degraded states, never decoration).
      rows.some((row) => row.state === "unavailable" || row.state === "unknown")
        ? supportEscape({
            context: {
              subject: "We need help with our organization's enterprise integrations.",
              detail: `The workspace reads: ${rows
                .map((row) => `${INTEGRATION_LANGUAGE[row.kind].label} — ${INTEGRATION_STATE_LANGUAGE[row.state]}`)
                .join("; ")}.`,
              refs: [],
            },
            label: "Get help with integrations",
          })
        : el(
            "p",
            { class: "muted", "data-integrations-support-reachability": "true" },
            text("If an integration status looks wrong or stale, Support is reachable from this workspace's Support section below."),
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
      // PA-004 (RL-114-F3): the journey trailing link joins the floored
      // `.journey-action a` family (the 44px touch-target floor).
      el("p", { class: "journey-action" }, el("a", { href: pagePath("intents") }, text("Manage goals"))),
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
    // PA-06: the guided connector enrollment (the connector journey step's
    // action surface - every stage renders from the read model; the only
    // writer is the provision-connector command through the app contract).
    connectorEnrollmentSection(input.session, input.workspace, input.command),
    orgConnectivitySection(input.connectivity),
    policySummarySection(input.workspace.policy),
    // PA-008: the enterprise integrations surface (the RL-115-F5 closure —
    // SSO/SCIM/MDM statuses render from the read model with EXACTLY the
    // four honest states; the section composes no configuration control).
    integrationsSection(input.workspace.integrations),
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
