/**
 * Human language for authoritative state vocabularies (RL-083, spec
 * ux-architecture.md §2/§7: "UI labels are allowed to be more human than
 * route names", Gap B of the user-journey audit).
 *
 * These maps are PRESENTATION ONLY: they translate closed-vocabulary values
 * from the parsed read model into customer language. They never decide,
 * merge or reinterpret state — the authoritative value always renders too
 * (as a data attribute or a visible state word) so nothing is hidden.
 */
import type {
  DerivedExperienceStatus,
  IntentAccessClass,
  ShellConnectivityState,
} from "@roamlink/app-kit";

/** Human sentences for the explainable decision's derived statuses. */
export const DERIVED_EXPERIENCE_LANGUAGE: Readonly<
  Record<DerivedExperienceStatus, string>
> = Object.freeze({
  experience_supported: "Your goal is currently supported.",
  experience_degraded: "Your goal is partially satisfied right now.",
  experience_pending: "RoamLink is still working toward your goal.",
  experience_unresolved: "Your goal needs attention.",
  experience_closed: "This goal is closed.",
});

/** Human labels for the goal preference classes (access classes). */
export const ACCESS_CLASS_LANGUAGE: Readonly<Record<IntentAccessClass, string>> = Object.freeze({
  any_internet: "Full internet when you need it",
  work_apps_only: "Work apps stay reachable",
  streaming: "Smooth streaming quality",
  low_power: "Use as little power as possible",
  metered_cost_cap: "Keep costs under control",
  privacy_first: "Prefer private, trusted paths",
  regional_compliance: "Respect regional rules",
});

/** Device status language (devices page + onboarding). */
export const DEVICE_STATUS_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  enrolled: "Enrolled — waiting to be used",
  active: "Ready",
  suspended: "Paused",
  retired: "Retired",
});

/** Device platform labels. */
export const DEVICE_PLATFORM_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  ios: "iPhone / iPad",
  android: "Android",
  macos: "Mac",
  windows: "Windows PC",
  linux: "Linux",
  embedded: "Embedded device",
  other: "Other",
});

// ---------------------------------------------------------------------------------
// RL-084 — the Connectivity Center vocabulary (spec/ux-architecture.md §6).
//
// All phrases below are PRESENTATION-ONLY translations of authoritative read
// model values. None of them decides, merges or invents state: the honest
// connection journey is derived only from what the projection asserts
// (reference lifecycle, delivery evidence, freshness, device observations),
// and the authoritative value always renders alongside its human phrase.
// ---------------------------------------------------------------------------------

/**
 * The user-visible connection journey (spec/ux-architecture.md §6, tech-lead
 * handoff §8): the honest state machine rendered as a narrative. The stage
 * list is the frozen vocabulary; per-stage states are derived ONLY from
 * projection state (never from payment, orders or event arrival) in
 * lifecycle.ts.
 */
export const CONNECTION_STAGES = [
  "observed",
  "requested",
  "accepted",
  "reserved",
  "path-active",
  "delivery",
  "recovered",
] as const;
export type ConnectionStage = (typeof CONNECTION_STAGES)[number];

/** Human label + one-line explanation for each stage of the journey. */
export const CONNECTION_STAGE_LANGUAGE: Readonly<
  Record<ConnectionStage, { readonly label: string; readonly explanation: string }>
> = Object.freeze({
  observed: {
    label: "Observed",
    explanation: "RoamLink can see what your devices are experiencing.",
  },
  requested: {
    label: "Requested",
    explanation: "A connectivity request exists for you to deliver against.",
  },
  accepted: {
    label: "Accepted",
    explanation: "The network accepted the request.",
  },
  reserved: {
    label: "Reserved",
    explanation: "Capacity is set aside for your connection.",
  },
  "path-active": {
    label: "Path active",
    explanation: "A working path is carrying your connectivity.",
  },
  delivery: {
    label: "Delivery",
    explanation: "Delivery evidence shows your connection is really serving you.",
  },
  recovered: {
    label: "Recovered",
    explanation: "After a problem, service came back and was confirmed.",
  },
});

/** The honest per-stage states of the journey (a closed vocabulary). */
export const CONNECTION_STAGE_STATES = ["reached", "waiting", "not-recorded"] as const;
export type ConnectionStageState = (typeof CONNECTION_STAGE_STATES)[number];

/** Human sentence for each per-stage state (text + data attribute, never color alone). */
export const CONNECTION_STAGE_STATE_LANGUAGE: Readonly<
  Record<ConnectionStageState, string>
> = Object.freeze({
  reached: "Confirmed",
  waiting: "Waiting",
  "not-recorded": "Not recorded yet",
});

/** Human sentences for the connectivity reference lifecycle values. */
export const REFERENCE_STATUS_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  active: "Active — RoamLink is working with this reference",
  retired: "Retired — this reference is no longer in use",
  none: "None — nothing is requested yet",
});

/** Human sentences for the delivery-evidence states. */
export const DELIVERY_EVIDENCE_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  EVIDENCED: "Delivery evidenced — the network has confirmed real delivery",
  UNEVIDENCED: "Waiting for delivery evidence — the network has not confirmed delivery yet",
});

/**
 * The honest "why" narrative for each shell-level connectivity state
 * (spec/ux-architecture.md §6: why RoamLink is taking an action, what it is
 * waiting for, what the customer can do next). Keyed by the shared derived
 * shell state vocabulary; every phrase states its evidence honestly.
 */
export const CONNECTIVITY_WHY_LANGUAGE: Readonly<
  Record<
    ShellConnectivityState,
    { readonly why: string; readonly waitingFor: string; readonly nextStep: string }
  >
> = Object.freeze({
  "evidenced-fresh": {
    why: "Your delivery evidence is linked and fresh, so RoamLink treats your connection as usefully working. RoamLink keeps watching in the background.",
    waitingFor: "Nothing right now — no action is waiting on you or on the network.",
    nextStep: "No action needed. If anything changes, RoamLink will explain it here and in Activity.",
  },
  "evidenced-stale": {
    why: "Delivery was evidenced, but the freshness guarantee on that evidence has expired. RoamLink does not claim success from old evidence, so it is watching closely for renewed proof.",
    waitingFor: "RoamLink is waiting for renewed delivery evidence. If it does not arrive, RoamLink works on recovery.",
    nextStep: "You can wait — most staleness resolves on its own. If this persists, open a support case.",
  },
  "evidenced-unknown": {
    why: "Delivery evidence is linked, but RoamLink cannot confirm how fresh it is. Unconfirmed freshness is treated as not confirmed.",
    waitingFor: "RoamLink is waiting for evidence it can verify.",
    nextStep: "No action is required yet. RoamLink keeps checking and will tell you what changed.",
  },
  unevidenced: {
    why: "Your connectivity is requested but the network has not confirmed delivery yet. This is not a failure — it only becomes a problem if it stays this way.",
    waitingFor: "RoamLink is waiting for the network to confirm delivery.",
    nextStep: "If this takes longer than you expect, check Activity for what RoamLink has done, or contact support.",
  },
  "no-reference": {
    why: "Nothing is set up to deliver connectivity yet, so there is nothing for RoamLink to manage.",
    waitingFor: "RoamLink is waiting for you to choose a goal and enroll a device.",
    nextStep: "Choose a goal in onboarding or enroll a device, and RoamLink will take it from there.",
  },
  unverifiable: {
    why: "RoamLink could not read the authoritative connectivity state, so nothing is claimed either way — this is not a success and not a failure.",
    waitingFor: "RoamLink is waiting until the connectivity read is available again.",
    nextStep: "Try again shortly. If the page keeps failing, open a support case.",
  },
});

// ---------------------------------------------------------------------------------
// RL-085 — the Activity narrative vocabulary (spec/ux-architecture.md §8).
//
// The map translates a durable notification's OWN recorded state transition
// (its aggregateType + transition pair, verbatim from the read model) into
// the customer-facing automation narrative: what happened, and the kind of
// thing it was. Unknown pairs fall back to the honest "recorded" narrative —
// never a fabricated story. Commerce records always stay their own kind:
// a commerce event NEVER renders as connectivity progress (RL-LOCK-008).
// ---------------------------------------------------------------------------------

/** The customer-facing kinds of activity entries (a closed vocabulary). */
export const ACTIVITY_ENTRY_KINDS = [
  "delivery",
  "recovery",
  "request",
  "commerce",
  "support",
  "system",
  "recorded",
] as const;
export type ActivityEntryKind = (typeof ACTIVITY_ENTRY_KINDS)[number];

/** Human label for each activity kind. */
export const ACTIVITY_KIND_LANGUAGE: Readonly<Record<ActivityEntryKind, string>> = Object.freeze({
  delivery: "Delivery",
  recovery: "Recovery",
  request: "Request",
  commerce: "Commerce",
  support: "Support",
  system: "System",
  recorded: "Recorded change",
});

/** The narrative shape for one recorded state change. */
export interface ActivityNarrative {
  readonly kind: ActivityEntryKind;
  /** What happened, in one human sentence. */
  readonly whatHappened: string;
}

/**
 * Narratives for the known RoamLink state transitions. Keyed by
 * `<aggregateType>::<transition>` exactly as the durable notification
 * records it. This map ADDS explanation only — it never changes the
 * authoritative record (the raw transition always renders too).
 */
const KNOWN_EVENT_NARRATIVES: Readonly<Record<string, ActivityNarrative>> = Object.freeze({
  "connectivity_reference::evidence_linked": {
    kind: "delivery",
    whatHappened:
      "Delivery evidence was linked for your connectivity, so the network has confirmed real delivery.",
  },
  "connectivity_reference::created": {
    kind: "request",
    whatHappened: "RoamLink recorded a new connectivity reference to deliver against.",
  },
  "connectivity_reference::retired": {
    kind: "request",
    whatHappened: "An older connectivity reference was retired and is no longer in use.",
  },
});

/** The honest fallback when a transition is not in the known narrative map. */
export function activityNarrativeFor(
  aggregateType: string,
  transition: string,
  title: string,
): ActivityNarrative {
  const known = KNOWN_EVENT_NARRATIVES[`${aggregateType}::${transition}`];
  if (known !== undefined) return known;
  return {
    kind: "recorded",
    whatHappened: title,
  };
}

// ---------------------------------------------------------------------------------
// RL-087 — the device capability vocabulary (spec/ux-architecture.md §9,
// tech-lead handoff §10, RL-LOCK-011).
//
// Capability truth is evidence-based: the read model carries the freshness
// of the device's capability/context snapshots, NOT the capability facts
// themselves, so the capability card renders only what the projection
// asserts and presents missing/unverified data honestly as UNKNOWN — never
// an assumed capability (RL-LOCK-011: the implementation cannot assume
// OS/radio capabilities not exposed by the platform).
// ---------------------------------------------------------------------------------

/** The honest not-verified statement (the total fallback of the map below). */
export const DEVICE_CAPABILITY_UNKNOWN = Object.freeze({
  label: "Not verified yet",
  detail:
    "RoamLink has not verified what this device can do yet. Until then, nothing is assumed and RoamLink asks before acting.",
});

/**
 * The device-level capability statement, derived only from the capability
 * snapshot's freshness. A closed vocabulary keyed by freshness state.
 */
export const DEVICE_CAPABILITY_LANGUAGE: Readonly<
  Record<string, { readonly label: string; readonly detail: string }>
> = Object.freeze({
  FRESH: {
    label: "Verified recently",
    detail:
      "RoamLink recently verified what this device can do. The verified capabilities ride with the device itself.",
  },
  STALE: {
    label: "Needs re-checking",
    detail:
      "The last capability verification has expired, so RoamLink treats unconfirmed abilities as unavailable and falls back to asking you.",
  },
  UNKNOWN: DEVICE_CAPABILITY_UNKNOWN,
});

/** Human sentence for each automation level (the capability key). */
export const AUTOMATION_LEVEL_LANGUAGE: Readonly<
  Record<string, string>
> = Object.freeze({
  automatic: "Automatic — RoamLink can act without asking you first.",
  confirmation: "With your confirmation — RoamLink asks, you approve, then it acts.",
  manual: "Manual — RoamLink tells you what to do; you do it on the device.",
  unavailable: "Unavailable — the device or its platform cannot do this at all.",
  unknown: "Unknown — not verified for this device yet; RoamLink assumes nothing.",
});

/** Static manual fallback guidance (presentation guidance, not authority). */
export const MANUAL_FALLBACK_GUIDANCE: readonly string[] = Object.freeze([
  "You can always connect or switch networks yourself from the device's own settings — RoamLink never takes that ability away.",
  "If RoamLink cannot act on this device, it says so and gives you the steps instead of failing silently.",
]);

// ---------------------------------------------------------------------------------
// RL-115-F1 remediation (PA-001) — the SIM & Profiles vocabulary
// (spec/ux-architecture.md §9 + §15; spec/architecture.md §7).
//
// Presentation-only translations of the eSIM read model's closed vocabularies.
// A status row is EVIDENCE, never a permission: actions pass the capability
// gate first (RL-LOCK-011), and a blocked action renders its manual guidance
// from the closed map below — never a disabled mystery.
// ---------------------------------------------------------------------------------

/** Human sentences for the per-capability platform statuses. */
export const ESIM_CAPABILITY_STATUS_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  available: "Available — the platform reports this works on this device",
  "requires-permission":
    "Needs your permission — the platform requires an explicit permission grant first",
  unavailable: "Not available — the platform reports this device cannot do this",
  unknown: "Not verified yet — no evidence recorded for this device",
});

/** Human sentences for the gate preview decisions. */
export const ESIM_GATE_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  allow: "Allowed now",
  deny: "Blocked",
  degrade: "Blocked until you grant the permission",
});

/** Human sentences for the honest eSIM profile states. */
export const ESIM_PROFILE_STATE_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  enabled: "Installed and enabled",
  disabled: "Installed, currently disabled",
  "install-requested": "Install requested — waiting for the device to confirm",
  "remove-requested": "Removal requested — waiting for the device to confirm",
});

/**
 * The CLOSED manual-guidance map for blocked eSIM actions, keyed by the
 * gate's closed reason vocabulary (the same map discipline the mobile
 * capability surface carries). Presentation guidance, never authority: it
 * tells the customer what to do on the device itself when RoamLink cannot
 * act — instead of hiding the action behind a disabled control.
 */
export function esimManualGuidanceFor(reason: string | null, capability: string): string {
  const words = capability.replace(/_/g, " ");
  switch (reason) {
    case "capability-requires-permission":
      return `Grant the ${words} permission in this device's platform settings, then come back — RoamLink never bypasses a platform permission.`;
    case "capability-unavailable":
      return `The platform reports ${words} as unavailable on this device. Use the device's own settings to manage it manually.`;
    case "capability-unknown":
      return `RoamLink has no evidence yet for ${words} on this device — nothing is assumed; the observation fills this in.`;
    case "evidence-class-insufficient":
      return `The evidence for ${words} is too weak to act on — wait for a fresh observation before trying again.`;
    case "evidence-stale":
      return `The ${words} observation has expired — re-check this device before acting.`;
    default:
      return "Use the device's own settings to manage this manually — RoamLink only acts on verified capability evidence.";
  }
}
