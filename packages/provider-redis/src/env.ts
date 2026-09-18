/**
 * Fail-closed environment access for the Upstash Redis path (RL-096).
 *
 * Keys: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (deployment.md
 * §2/§6). These keys are NOT part of the root env schema (packages/
 * contracts owns that closed key set); they are provider-specific secrets
 * read HERE, kept in private fields, redacted from every stringification,
 * and never echoed (RL-LOCK-016).
 */
import { ValidationError } from "@roamlink/contracts";
import { inspect } from "node:util";

export const UPSTASH_REDIS_ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;

export type UpstashRedisEnvSource = Readonly<Record<string, string | undefined>>;

export type ParseUpstashRedisEnvResult =
  | { readonly ok: true; readonly config: UpstashRedisRestEnv }
  | { readonly ok: false; readonly error: ValidationError };

/** Validated, secret-redacting Upstash Redis REST config. */
export class UpstashRedisRestEnv {
  readonly baseUrl: string;
  readonly #token: string;

  /** Not meant for direct use - construct via `tryParseUpstashRedisEnv`. */
  constructor(init: { readonly baseUrl: string; readonly token: string }) {
    this.baseUrl = init.baseUrl;
    this.#token = init.token;
    Object.freeze(this);
  }

  /** The bearer token for legitimate runtime use only (never logged). */
  get token(): string {
    return this.#token;
  }

  toString(): string {
    return `UpstashRedisRestEnv(baseUrl=${this.baseUrl}, token=[REDACTED])`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function issue(path: string, problem: string): { path: string; issue: string } {
  return { path, issue: problem };
}

/**
 * Reads and validates the Upstash Redis REST credentials. Missing/blank
 * keys produce a value-free error NAMING the key (the accelerator is
 * optional - callers treat a missing config as "run without Redis").
 */
export function tryParseUpstashRedisEnv(source: UpstashRedisEnvSource): ParseUpstashRedisEnvResult {
  const issues: { path: string; issue: string }[] = [];

  const urlRaw = source[UPSTASH_REDIS_ENV_KEYS[0]];
  if (urlRaw === undefined || urlRaw.trim() === "") {
    issues.push(issue(UPSTASH_REDIS_ENV_KEYS[0], "required when the Redis accelerator is configured"));
  } else {
    try {
      const url = new URL(urlRaw);
      if (url.protocol !== "https:") {
        issues.push(issue(UPSTASH_REDIS_ENV_KEYS[0], "must be an https URL"));
      }
    } catch {
      issues.push(issue(UPSTASH_REDIS_ENV_KEYS[0], "must be an absolute https URL"));
    }
  }

  const tokenRaw = source[UPSTASH_REDIS_ENV_KEYS[1]];
  if (tokenRaw === undefined || tokenRaw.trim() === "") {
    issues.push(issue(UPSTASH_REDIS_ENV_KEYS[1], "required when the Redis accelerator is configured"));
  } else if (!/^[\x21-\x7e]+$/.test(tokenRaw) || tokenRaw.length > 512) {
    issues.push(issue(UPSTASH_REDIS_ENV_KEYS[1], "must be printable non-whitespace ASCII (max 512 chars)"));
  }

  if (issues.length > 0) {
    const names = issues.map((detail) => detail.path).join(", ");
    return {
      ok: false,
      error: new ValidationError(
        `Upstash Redis environment validation failed with ${issues.length} problem(s); missing/invalid keys: ${names} (values are never included)`,
        { reason: "REDIS_ENV_INVALID", details: issues },
      ),
    };
  }

  return {
    ok: true,
    config: new UpstashRedisRestEnv({
      baseUrl: urlRaw as string,
      token: tokenRaw as string,
    }),
  };
}
