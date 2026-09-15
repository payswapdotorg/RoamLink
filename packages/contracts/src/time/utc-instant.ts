/**
 * UTC instant primitive (RL-002, spec/data-model.md "Time and freshness").
 *
 * All persisted timestamps are UTC instants with explicit serialization.
 * `UtcInstant` is a branded string holding the canonical ISO-8601 form
 * `YYYY-MM-DDTHH:MM:SS.mmmZ` (millisecond precision, always UTC `Z`).
 *
 * Parsing is strict and fail-closed:
 *  - naive/local time (no zone designator) is REJECTED - the classic
 *    server-timezone bug must be impossible to introduce;
 *  - explicit `±HH:MM` offsets are accepted and converted deterministically
 *    to the canonical UTC instant (the offset is explicit, so no guessing);
 *  - date-only, basic format (`20260915T...`), space separators, lowercase
 *    `t`/`z`, 24:00:00, leap seconds (`:60`) and >3 fractional digits are
 *    rejected - RoamLink instants are millisecond precision;
 *  - impossible calendar dates (e.g. Feb 30) are rejected.
 */
import type { Branded } from "../brand.js";
import { ValidationError } from "../errors/errors.js";

export type UtcInstant = Branded<"UtcInstant">;

const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Maximum representable ECMAScript Date epoch (±8.64e15 ms from epoch). */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error("utc-instant: regex group invariant violated");
  }
  return value;
}

function invalid(issue: string): never {
  throw new ValidationError(
    `UtcInstant must be an ISO-8601 timestamp with an explicit zone designator in the form YYYY-MM-DDTHH:MM:SS[.mmm]Z (naive/local time is rejected): ${issue}`,
    { reason: "TIMESTAMP_INVALID", details: [{ path: "UtcInstant", issue }] },
  );
}

export function parseUtcInstant(value: unknown): UtcInstant {
  if (typeof value !== "string") {
    invalid("value is not a string");
  }
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (match === null) {
    invalid(
      "expected extended format with uppercase 'T' separator and 'Z' or '±HH:MM' zone designator",
    );
  }
  const year = Number(group(match, 1));
  const month = Number(group(match, 2));
  const day = Number(group(match, 3));
  const hour = Number(group(match, 4));
  const minute = Number(group(match, 5));
  const second = Number(group(match, 6));
  // group 7 (fractional seconds) is optional - absent means .000
  const fraction = match[7] ?? "";
  const zone = group(match, 8);

  if (month < 1 || month > 12) invalid("month out of range 01-12");
  if (day < 1 || day > 31) invalid("day out of range 01-31");
  if (hour > 23) invalid("hour out of range 00-23");
  if (minute > 59) invalid("minute out of range 00-59");
  if (second > 59) invalid("second out of range 00-59 (leap seconds are not representable)");

  let offsetMs = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) invalid("zone offset out of range");
    const sign = zone.charAt(0) === "+" ? 1 : -1;
    offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }

  // setUTCFullYear (unlike Date.UTC) interprets years 0-99 literally.
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(year, month - 1, day);
  asUtc.setUTCHours(hour, minute, second, 0);
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day ||
    asUtc.getUTCHours() !== hour ||
    asUtc.getUTCMinutes() !== minute ||
    asUtc.getUTCSeconds() !== second
  ) {
    invalid("calendar date does not exist (e.g. Feb 30) or component rollover");
  }
  if (fraction.length > 0) {
    asUtc.setUTCMilliseconds(Math.round(Number(fraction) * 1000));
  }

  const epochMs = asUtc.getTime() - offsetMs;
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) {
    invalid("instant outside the representable UTC range");
  }
  return new Date(epochMs).toISOString() as UtcInstant;
}

export function isUtcInstant(value: unknown): value is UtcInstant {
  if (typeof value !== "string") return false;
  try {
    parseUtcInstant(value);
    return true;
  } catch {
    return false;
  }
}

/** Current instant. Non-deterministic by nature; pass explicit instants in tests. */
export function nowUtc(): UtcInstant {
  return new Date().toISOString() as UtcInstant;
}

export function utcInstantFromEpochMs(epochMs: number): UtcInstant {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || !Number.isInteger(epochMs)) {
    throw new ValidationError("epoch milliseconds must be a finite integer", {
      reason: "TIMESTAMP_INVALID",
      details: [{ path: "UtcInstant.epochMs", issue: "not a finite integer" }],
    });
  }
  if (Math.abs(epochMs) > MAX_EPOCH_MS) {
    throw new ValidationError("epoch milliseconds outside the representable UTC range", {
      reason: "TIMESTAMP_INVALID",
      details: [{ path: "UtcInstant.epochMs", issue: "out of range" }],
    });
  }
  return new Date(epochMs).toISOString() as UtcInstant;
}

export function epochMsOf(instant: UtcInstant): number {
  return new Date(instant).getTime();
}

/** Negative when `a` is before `b`, 0 when equal, positive when after. */
export function compareUtcInstants(a: UtcInstant, b: UtcInstant): number {
  return epochMsOf(a) - epochMsOf(b);
}

/** Returns a new instant shifted by whole milliseconds (negative allowed). */
export function addMilliseconds(instant: UtcInstant, ms: number): UtcInstant {
  if (typeof ms !== "number" || !Number.isInteger(ms)) {
    throw new ValidationError("offset must be an integer number of milliseconds", {
      reason: "TIMESTAMP_INVALID",
      details: [{ path: "UtcInstant.offsetMs", issue: "not an integer" }],
    });
  }
  return utcInstantFromEpochMs(epochMsOf(instant) + ms);
}
