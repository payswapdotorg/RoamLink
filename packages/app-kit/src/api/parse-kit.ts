/**
 * Internal strict-parsing kit for wire resources (app-kit contract layer).
 *
 * Every wire shape is parsed fail-closed: unknown fields are rejected (the
 * contract is closed), enum values are checked against their vocabulary,
 * timestamps go through the Wave-0 UTC-instant parser, and numbers must be
 * exact. Parsers never repair, guess or echo offending values (RL-LOCK-016).
 */
import { parseUtcInstant, ValidationError } from "@roamlink/contracts";

export function asObject(label: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not an object" }],
    });
  }
  return value as Record<string, unknown>;
}

export function asArray(label: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not an array" }],
    });
  }
  return value;
}

export function requireFields(label: string, record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (record[field] === undefined) {
      throw new ValidationError(`${label}.${field} is required`, {
        reason: "RESOURCE_INVALID",
        details: [{ path: `${label}.${field}`, issue: "missing required field" }],
      });
    }
  }
}

export function rejectUnknownFields(label: string, record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new ValidationError(`${label} rejected unknown field '${key}'`, {
        reason: "RESOURCE_INVALID",
        details: [{ path: `${label}.${key}`, issue: "unknown field (closed contract)" }],
      });
    }
  }
}

export function asString(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not a non-empty string" }],
    });
  }
  return value;
}

export function asOptionalString(label: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return asString(label, value);
}

export function asNullableString(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(label, value);
}

export function asInstant(label: string, value: unknown): string {
  try {
    return parseUtcInstant(value);
  } catch {
    throw new ValidationError(`${label} must be a UTC instant string with an explicit zone designator`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not a UTC instant" }],
    });
  }
}

export function asNullableInstant(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asInstant(label, value);
}

export function asOptionalInstant(label: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return asInstant(label, value);
}

export function asPositiveInt(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive integer`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not a positive integer" }],
    });
  }
  return value;
}

export function asNonNegativeInt(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative integer`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not a non-negative integer" }],
    });
  }
  return value;
}

export function asBoolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not a boolean" }],
    });
  }
  return value;
}

export function asEnum<T extends string>(
  label: string,
  vocabulary: readonly T[],
  value: unknown,
): T {
  if (typeof value !== "string" || !(vocabulary as readonly string[]).includes(value)) {
    throw new ValidationError(`${label} must be one of the closed vocabulary (${vocabulary.join(", ")})`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "outside the closed vocabulary" }],
    });
  }
  return value as T;
}

export function asNumberOrNull(label: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a number or null`, {
      reason: "RESOURCE_INVALID",
      details: [{ path: label, issue: "not a finite number" }],
    });
  }
  return value;
}

/** Parses a readonly array with a per-element parser. */
export function arrayOf<T>(
  label: string,
  value: unknown,
  parseElement: (elementLabel: string, element: unknown) => T,
): readonly T[] {
  const raw = asArray(label, value);
  return Object.freeze(raw.map((entry, index) => parseElement(`${label}[${index}]`, entry)));
}
