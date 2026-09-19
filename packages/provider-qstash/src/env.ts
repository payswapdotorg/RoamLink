/**
 * Fail-closed environment access for the QStash path (RL-097).
 *
 * Keys (deployment.md §2/§6): QSTASH_TOKEN (publish credential),
 * QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY (receiver-side
 * verification + rotation), QSTASH_URL (optional endpoint override).
 * Provider secrets are NOT root-schema keys; they are read here, held in
 * private fields, redacted from every stringification (RL-LOCK-016).
 */
import { ValidationError } from "@roamlink/contracts";
import { inspect } from "node:util";

export const QSTASH_ENV_KEYS = [
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "QSTASH_URL",
] as const;

export type QStashEnvSource = Readonly<Record<string, string | undefined>>;

export type ParseQStashEnvResult =
  | { readonly ok: true; readonly config: QStashEnv }
  | { readonly ok: false; readonly error: ValidationError };

/** Validated, secret-redacting QStash env config. */
export class QStashEnv {
  readonly #token: string;
  readonly #currentSigningKey: string;
  readonly #nextSigningKey: string | null;
  readonly baseUrl: string | null;

  /** Not meant for direct use - construct via `tryParseQStashEnv`. */
  constructor(init: {
    readonly token: string;
    readonly currentSigningKey: string;
    readonly nextSigningKey?: string;
    readonly baseUrl?: string;
  }) {
    this.#token = init.token;
    this.#currentSigningKey = init.currentSigningKey;
    this.#nextSigningKey = init.nextSigningKey ?? null;
    this.baseUrl = init.baseUrl ?? null;
    Object.freeze(this);
  }

  /** Publish credential for legitimate runtime use (never logged). */
  get token(): string {
    return this.#token;
  }

  /** Receiver verification key (never logged). */
  get currentSigningKey(): string {
    return this.#currentSigningKey;
  }

  /** Rotation window key (never logged); null when not configured. */
  get nextSigningKey(): string | null {
    return this.#nextSigningKey;
  }

  toString(): string {
    return `QStashEnv(baseUrl=${this.baseUrl ?? "[default]"}, token=[REDACTED], currentSigningKey=[REDACTED], nextSigningKey=${this.#nextSigningKey === null ? "[absent]" : "[REDACTED]"})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function issue(path: string, problem: string): { path: string; issue: string } {
  return { path, issue: problem };
}

function validateSecret(key: string, value: string, issues: { path: string; issue: string }[]): void {
  if (!/^[\x21-\x7e]+$/.test(value) || value.length > 512) {
    issues.push(issue(key, "must be printable non-whitespace ASCII (max 512 chars)"));
  }
}

/**
 * Reads and validates QStash credentials. Missing token/signing keys fail
 * with a value-free error NAMING the keys (callers without QStash run
 * their non-delivered path; delivery is optional per environment).
 */
export function tryParseQStashEnv(source: QStashEnvSource): ParseQStashEnvResult {
  const issues: { path: string; issue: string }[] = [];

  const token = source["QSTASH_TOKEN"];
  if (token === undefined || token.trim() === "") {
    issues.push(issue("QSTASH_TOKEN", "required when QStash delivery is configured"));
  } else {
    validateSecret("QSTASH_TOKEN", token, issues);
  }

  const currentSigningKey = source["QSTASH_CURRENT_SIGNING_KEY"];
  if (currentSigningKey === undefined || currentSigningKey.trim() === "") {
    issues.push(issue("QSTASH_CURRENT_SIGNING_KEY", "required when QStash delivery is configured (receivers verify signatures)"));
  } else {
    validateSecret("QSTASH_CURRENT_SIGNING_KEY", currentSigningKey, issues);
  }

  const nextSigningKey = source["QSTASH_NEXT_SIGNING_KEY"];
  if (nextSigningKey !== undefined && nextSigningKey.trim() !== "") {
    validateSecret("QSTASH_NEXT_SIGNING_KEY", nextSigningKey, issues);
  }

  const baseUrl = source["QSTASH_URL"];
  if (baseUrl !== undefined && baseUrl.trim() !== "") {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:") issues.push(issue("QSTASH_URL", "must be an https URL"));
    } catch {
      issues.push(issue("QSTASH_URL", "must be an absolute https URL"));
    }
  }

  if (issues.length > 0) {
    const names = issues.map((detail) => detail.path).join(", ");
    return {
      ok: false,
      error: new ValidationError(
        `QStash environment validation failed with ${issues.length} problem(s); missing/invalid keys: ${names} (values are never included)`,
        { reason: "QSTASH_ENV_INVALID", details: issues },
      ),
    };
  }

  return {
    ok: true,
    config: new QStashEnv({
      token: token as string,
      currentSigningKey: currentSigningKey as string,
      ...(nextSigningKey !== undefined && nextSigningKey.trim() !== "" ? { nextSigningKey } : {}),
      ...(baseUrl !== undefined && baseUrl.trim() !== "" ? { baseUrl } : {}),
    }),
  };
}
