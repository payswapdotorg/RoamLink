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
import type { DerivedExperienceStatus, IntentAccessClass } from "@roamlink/app-kit";

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
