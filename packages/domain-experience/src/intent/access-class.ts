/**
 * Preferred access classes (RL-011, RL-LOCK-007) - PREFERENCES ONLY.
 *
 * These are RoamLink EXPERIENCE-side preference labels a customer may rank
 * when expressing an intent ("prefer trusted Wi-Fi when it satisfies the
 * target"). They are NOT network facts, NOT availability claims and NOT
 * ADCOS access classes: the Wave-2 intent compiler (RL-012) maps them into
 * ADCOS ConnectivityIntent PREFERENCES, never into constraints. The
 * vocabulary is closed and defined here; anything else is rejected.
 */
import { ValidationError } from "@roamlink/contracts";

export const ACCESS_CLASS_NAMES = [
  "trusted_wifi",
  "open_wifi",
  "home_cellular",
  "roaming_cellular",
  "wired",
  "satellite",
  "hotspot",
] as const;

export type AccessClassName = (typeof ACCESS_CLASS_NAMES)[number];

export const ACCESS_CLASS_DESCRIPTIONS: Readonly<Record<AccessClassName, string>> =
  Object.freeze({
    trusted_wifi: "Wi-Fi networks the customer has marked as trusted.",
    open_wifi: "Open (unencrypted) Wi-Fi networks - preference only, never a constraint.",
    home_cellular: "The device's home cellular provider.",
    roaming_cellular: "Cellular connectivity while roaming.",
    wired: "Wired connectivity where available.",
    satellite: "Satellite connectivity where available.",
    hotspot: "Tethered/hotspot connectivity.",
  });

export function isAccessClassName(value: unknown): value is AccessClassName {
  return typeof value === "string" && (ACCESS_CLASS_NAMES as readonly string[]).includes(value);
}

/** Parses an access-class preference (closed vocabulary, no echo). */
export function parseAccessClassName(value: unknown): AccessClassName {
  if (!isAccessClassName(value)) {
    throw new ValidationError(
      "value is not a member of the closed access-class preference vocabulary (trusted_wifi, open_wifi, home_cellular, roaming_cellular, wired, satellite, hotspot - preferences only, RL-LOCK-007)",
      {
        reason: "ACCESS_CLASS_INVALID",
        details: [{ path: "AccessClassName", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value;
}
