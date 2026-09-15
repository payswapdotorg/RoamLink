/**
 * Deterministic ID generator port (RL-040 platform scaffolding).
 *
 * A port plus dependency-free implementations so tests (and later the edge
 * sync engine, RL-042) can generate identifiers deterministically instead of
 * relying on `crypto.randomUUID()` randomness.
 */
import { ValidationError } from "@roamlink/contracts";

/** Deterministic string ID generator port. */
export interface IdGenerator {
  next(): string;
}

const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;

/** Largest seed encodable in the 12-hex-digit suffix of a generated UUID. */
export const MAX_DETERMINISTIC_UUID_SEED = 0xffff_ffff_ffff;

/**
 * Deterministic, canonical-shaped UUID from a numeric seed:
 * `00000000-0000-4000-8000-XXXXXXXXXXXX` (12 zero-padded hex digits).
 *
 * The result matches the Wave-0 canonical lowercase UUID grammar and is never
 * the nil UUID, so it passes `parseCanonicalUuidAs`-based parsers. The same
 * seed always yields the same UUID.
 */
export function deterministicUuidFromSeed(seed: number): string {
  if (
    typeof seed !== "number" ||
    !Number.isInteger(seed) ||
    seed < 1 ||
    seed > MAX_DETERMINISTIC_UUID_SEED
  ) {
    throw new ValidationError(
      "seed must be an integer between 1 and 281474976710655 (12 hex digits)",
      {
        reason: "ID_SEED_INVALID",
        details: [{ path: "seed", issue: "not an integer within the encodable range" }],
      },
    );
  }
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

/** Generates `prefix + counter` strings (default `id-1`, `id-2`, ...). */
export class SequenceIdGenerator implements IdGenerator {
  readonly #prefix: string;
  #counter: number;

  constructor(options?: { readonly prefix?: string; readonly start?: number }) {
    const prefix = options?.prefix ?? "id-";
    if (prefix !== "" && !PREFIX_PATTERN.test(prefix)) {
      throw new ValidationError("SequenceIdGenerator prefix must be empty or a short safe label", {
        reason: "ID_PREFIX_INVALID",
        details: [{ path: "prefix", issue: "must be 1-32 chars, start alphanumeric, then [A-Za-z0-9._:-] only" }],
      });
    }
    const start = options?.start ?? 1;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0) {
      throw new ValidationError("SequenceIdGenerator start must be a non-negative integer", {
        reason: "ID_START_INVALID",
        details: [{ path: "start", issue: "must be a non-negative integer" }],
      });
    }
    this.#prefix = prefix;
    this.#counter = start;
  }

  next(): string {
    const value = `${this.#prefix}${this.#counter}`;
    this.#counter += 1;
    return value;
  }
}

/** Generates the deterministic seed UUID sequence (seed, seed+1, ...). */
export class DeterministicUuidGenerator implements IdGenerator {
  #nextSeed: number;

  constructor(start?: number) {
    const value = start ?? 1;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_DETERMINISTIC_UUID_SEED
    ) {
      throw new ValidationError(
        "DeterministicUuidGenerator start must be an integer between 1 and 281474976710655",
        {
          reason: "ID_START_INVALID",
          details: [{ path: "start", issue: "not an integer within the encodable range" }],
        },
      );
    }
    this.#nextSeed = value;
  }

  next(): string {
    return deterministicUuidFromSeed(this.#nextSeed++);
  }
}
