/**
 * Deterministic canonical JSON serialization (RL-002).
 *
 * Canonical form rules:
 *  - object keys are sorted recursively by UTF-16 code-unit order (never by
 *    locale), so key insertion order is irrelevant;
 *  - only JSON-native values are accepted: null, booleans, finite numbers,
 *    strings, arrays and plain objects (prototype `Object.prototype` or
 *    `null`). Dates, Maps, class instances, functions, symbols, bigints,
 *    `undefined` values/holes and cycles are REJECTED with a ValidationError
 *    naming the offending path - callers must pre-convert (e.g. instants are
 *    already canonical ISO-8601 strings);
 *  - numbers serialize via the ECMAScript Number::toString algorithm, which is
 *    fully specified and therefore stable across engines (`-0` normalizes to
 *    `0`, very large/small magnitudes use exponent form);
 *  - string escaping follows the ECMAScript JSON.stringify specification
 *    (well-formed since ES2019, deterministic for all inputs).
 *
 * Determinism contract: the same value always produces the same bytes and
 * therefore the same digest. The Wave-2 intent compiler and the projection
 * engine both rely on this.
 */
import { ValidationError } from "../errors/errors.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const MAX_DEPTH = 64;

function reject(path: string, issue: string): never {
  throw new ValidationError(
    `value at '${path}' cannot be canonically serialized: ${issue}`,
    {
      reason: "CANONICAL_JSON_INVALID",
      details: [{ path, issue }],
    },
  );
}

function canonicalize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        reject(path, "numbers must be finite (NaN and +/-Infinity are not JSON)");
      }
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      reject(path, `values of type '${typeof value}' (undefined/symbol/function/bigint) are not JSON`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    reject(path, "circular reference detected");
  }
  if (seen.size >= MAX_DEPTH) {
    reject(path, `nesting deeper than ${MAX_DEPTH} levels`);
  }

  if (Array.isArray(obj)) {
    seen.add(obj);
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i += 1) {
      const item = (obj as readonly unknown[])[i];
      if (item === undefined) {
        reject(`${path}[${i}]`, "array holes and undefined elements are not JSON");
      }
      parts.push(canonicalize(item, `${path}[${i}]`, seen));
    }
    seen.delete(obj);
    return `[${parts.join(",")}]`;
  }

  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    reject(
      path,
      "only plain objects are canonicalizable (convert Dates to UtcInstant strings, Maps/sets to arrays/objects before serializing)",
    );
  }

  const record = obj as Record<string, unknown>;
  seen.add(obj);
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) {
      reject(`${path}.${key}`, "explicit undefined properties are not JSON (omit the key instead)");
    }
    parts.push(`${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`, seen)}`);
  }
  seen.delete(obj);
  return `{${parts.join(",")}}`;
}

/**
 * Serializes a value to deterministic canonical JSON. Throws a ValidationError
 * (naming the path, never the value) for non-canonicalizable input.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, "$", new Set());
}

/**
 * Type predicate: does the value belong to the canonical JSON value space?
 * (Structural check only - cycles are not detected here.)
 */
export function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object": {
      if (Array.isArray(value)) {
        return value.every((item) => item !== undefined && isCanonicalJsonValue(item));
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value).every((item) => item !== undefined && isCanonicalJsonValue(item));
    }
    default:
      return false;
  }
}
