/**
 * Fail-closed environment validation (RL-001, RL-LOCK-016).
 *
 * The recognized key set matches `.env.example` EXACTLY (cross-checked by a
 * conformance test under tests/architecture). Unknown `ROAMLINK_*` / `ADCOS_*`
 * keys are rejected as likely typos.
 *
 * Behavior:
 *  - NODE_ENV is always required and must be development | test | production;
 *  - keys required in production fail loudly: the thrown ValidationError
 *    names the MISSING KEY NAME(S) but NEVER any value;
 *  - ADCOS_API_VERSION defaults to the pinned supported line: "2.0"
 *    (RoamLink targets ADCOS Developer API v2.0 only; older lines retired);
 *  - secrets (ADCOS_CLIENT_SECRET, ADCOS_WEBHOOK_SECRET) are stored in true
 *    private class fields and are redacted from toString(), util.inspect()
 *    and JSON.stringify(); use the accessors for legitimate use.
 *
 * The module is side-effect free: nothing reads process.env on import.
 * Applications call `parseEnv(process.env)` at startup.
 */
import { inspect } from "node:util";
import { ValidationError, type ErrorDetail } from "../errors/errors.js";

export const ENV_KEYS = [
  "NODE_ENV",
  "ROAMLINK_API_BASE_URL",
  "ROAMLINK_PUBLIC_API_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "ADCOS_API_BASE_URL",
  "ADCOS_API_VERSION",
  "ADCOS_CLIENT_ID",
  "ADCOS_CLIENT_SECRET",
  "ADCOS_WEBHOOK_SECRET",
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

const ENV_KEY_SET = new Set<string>(ENV_KEYS);

export const NODE_ENV_VALUES = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENV_VALUES)[number];

/**
 * The only supported ADCOS Developer API version line. 2.0 is the pinned
 * target (1.x/0.x retired/deprecated); compatibility beyond the pin is the
 * ADCOS compatibility suite's concern (RL-036), not the env schema's.
 */
export const SUPPORTED_ADCOS_API_VERSIONS = ["2.0"] as const;
export type AdcosApiVersion = (typeof SUPPORTED_ADCOS_API_VERSIONS)[number];

export const ADCOS_API_VERSION_DEFAULT: AdcosApiVersion = "2.0";

const REQUIRED_IN_PRODUCTION: readonly EnvKey[] = [
  "ROAMLINK_API_BASE_URL",
  "ROAMLINK_PUBLIC_API_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "ADCOS_API_BASE_URL",
  "ADCOS_CLIENT_ID",
  "ADCOS_CLIENT_SECRET",
  "ADCOS_WEBHOOK_SECRET",
];

const REDACTED = "[REDACTED]";

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Validated, secret-redacting environment.
 *
 * Secrets live in private class fields: they cannot leak through
 * JSON.stringify, console.log (util.inspect) or String(env). Access them via
 * the `adcosClientSecret` / `adcosWebhookSecret` getters.
 */
export class RoamLinkEnv {
  readonly nodeEnv: NodeEnv;
  readonly roamlinkApiBaseUrl: string;
  readonly roamlinkPublicApiUrl: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly adcosApiBaseUrl: string;
  readonly adcosApiVersion: AdcosApiVersion;
  readonly adcosClientId: string;
  readonly #adcosClientSecret: string;
  readonly #adcosWebhookSecret: string;

  /** Not meant for direct use - construct via {@link parseEnv}. */
  constructor(init: {
    readonly nodeEnv: NodeEnv;
    readonly roamlinkApiBaseUrl: string;
    readonly roamlinkPublicApiUrl: string;
    readonly databaseUrl: string;
    readonly redisUrl: string;
    readonly adcosApiBaseUrl: string;
    readonly adcosApiVersion: AdcosApiVersion;
    readonly adcosClientId: string;
    readonly adcosClientSecret: string;
    readonly adcosWebhookSecret: string;
  }) {
    this.nodeEnv = init.nodeEnv;
    this.roamlinkApiBaseUrl = init.roamlinkApiBaseUrl;
    this.roamlinkPublicApiUrl = init.roamlinkPublicApiUrl;
    this.databaseUrl = init.databaseUrl;
    this.redisUrl = init.redisUrl;
    this.adcosApiBaseUrl = init.adcosApiBaseUrl;
    this.adcosApiVersion = init.adcosApiVersion;
    this.adcosClientId = init.adcosClientId;
    this.#adcosClientSecret = init.adcosClientSecret;
    this.#adcosWebhookSecret = init.adcosWebhookSecret;
    Object.freeze(this);
  }

  get adcosClientSecret(): string {
    return this.#adcosClientSecret;
  }

  get adcosWebhookSecret(): string {
    return this.#adcosWebhookSecret;
  }

  toString(): string {
    return (
      `RoamLinkEnv(nodeEnv=${this.nodeEnv}, adcosApiVersion=${this.adcosApiVersion}, ` +
      `adcosClientSecret=${REDACTED}, adcosWebhookSecret=${REDACTED})`
    );
  }

  [inspect.custom](): string {
    return this.toString();
  }

  /** Structured, log-safe view with secrets replaced by a marker. */
  redactedView(): Readonly<Record<string, string>> {
    return Object.freeze({
      NODE_ENV: this.nodeEnv,
      ROAMLINK_API_BASE_URL: this.roamlinkApiBaseUrl,
      ROAMLINK_PUBLIC_API_URL: this.roamlinkPublicApiUrl,
      DATABASE_URL: this.databaseUrl,
      REDIS_URL: this.redisUrl,
      ADCOS_API_BASE_URL: this.adcosApiBaseUrl,
      ADCOS_API_VERSION: this.adcosApiVersion,
      ADCOS_CLIENT_ID: this.adcosClientId,
      ADCOS_CLIENT_SECRET: REDACTED,
      ADCOS_WEBHOOK_SECRET: REDACTED,
    });
  }
}

export type ParseEnvResult = { readonly ok: true; readonly env: RoamLinkEnv } | { readonly ok: false; readonly error: ValidationError };

function issue(path: string, problem: string): ErrorDetail {
  return { path, issue: problem };
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENV_VALUES as readonly string[]).includes(value);
}

function hasLeadingOrTrailingWhitespace(value: string): boolean {
  return value.length !== value.trim().length;
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validateUrl(key: EnvKey, value: string, issues: ErrorDetail[]): void {
  if (hasLeadingOrTrailingWhitespace(value)) {
    issues.push(issue(key, "must not have leading/trailing whitespace"));
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push(issue(key, "must be an absolute http(s) URL"));
    }
  } catch {
    issues.push(issue(key, "must be an absolute http(s) URL"));
  }
}

function validateConnection(key: EnvKey, value: string, issues: ErrorDetail[]): void {
  if (/\s/.test(value) || hasControlCharacters(value) || value.length > 2048) {
    issues.push(issue(key, "must be a whitespace-free connection string of at most 2048 chars"));
  }
}

function validateSecret(key: EnvKey, value: string, issues: ErrorDetail[]): void {
  const printable = /^[\x21-\x7e]+$/;
  if (!printable.test(value) || value.length > 512) {
    issues.push(issue(key, "must consist of printable non-whitespace ASCII (max 512 chars)"));
  }
}

function validatePresentValue(key: EnvKey, value: string, issues: ErrorDetail[]): void {
  switch (key) {
    case "ROAMLINK_API_BASE_URL":
    case "ROAMLINK_PUBLIC_API_URL":
    case "ADCOS_API_BASE_URL":
      validateUrl(key, value, issues);
      return;
    case "DATABASE_URL":
    case "REDIS_URL":
      validateConnection(key, value, issues);
      return;
    case "ADCOS_API_VERSION":
      if (!(SUPPORTED_ADCOS_API_VERSIONS as readonly string[]).includes(value)) {
        issues.push(
          issue(key, `must be one of the supported ADCOS API versions: ${SUPPORTED_ADCOS_API_VERSIONS.join(", ")}`),
        );
      }
      return;
    case "ADCOS_CLIENT_ID": {
      const printable = /^[\x21-\x7e]+$/;
      if (!printable.test(value) || value.length > 255) {
        issues.push(issue(key, "must consist of printable non-whitespace ASCII (max 255 chars)"));
      }
      return;
    }
    case "ADCOS_CLIENT_SECRET":
    case "ADCOS_WEBHOOK_SECRET":
      validateSecret(key, value, issues);
      return;
    default:
      return;
  }
}


/**
 * Validates an environment source and returns a {@link RoamLinkEnv}.
 * Throws a ValidationError naming missing/invalid KEYS ONLY (never values).
 */
export function parseEnv(source: EnvSource): RoamLinkEnv {
  const result = tryParseEnv(source);
  if (!result.ok) {
    throw result.error;
  }
  return result.env;
}

/** Result-style variant of {@link parseEnv}. */
export function tryParseEnv(source: EnvSource): ParseEnvResult {
  const issues: ErrorDetail[] = [];

  for (const key of Object.keys(source)) {
    if (!/^(ROAMLINK|ADCOS)_/i.test(key)) continue;
    if (!ENV_KEY_SET.has(key)) {
      issues.push(issue(key, "unknown environment key (check spelling against .env.example)"));
    }
  }

  const nodeEnvRaw = source["NODE_ENV"];
  let nodeEnv: NodeEnv;
  if (nodeEnvRaw === undefined || nodeEnvRaw.trim() === "") {
    issues.push(issue("NODE_ENV", "required (one of: development, test, production)"));
    nodeEnv = "development";
  } else if (!isNodeEnv(nodeEnvRaw)) {
    issues.push(issue("NODE_ENV", `must be one of: ${NODE_ENV_VALUES.join(", ")}`));
    nodeEnv = "development";
  } else {
    nodeEnv = nodeEnvRaw;
  }

  const values = new Map<EnvKey, string>();
  for (const key of ENV_KEYS) {
    if (key === "NODE_ENV") continue;
    const raw = source[key];
    if (raw === undefined || raw.trim() === "") {
      continue; // absent/blank == unset
    }
    validatePresentValue(key, raw, issues);
    values.set(key, raw);
  }

  if (nodeEnv === "production") {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!values.has(key)) {
        issues.push(issue(key, "required when NODE_ENV=production"));
      }
    }
  }

  if (issues.length > 0) {
    const keyNames = issues.map((detail) => detail.path).join(", ");
    return {
      ok: false,
      error: new ValidationError(
        `RoamLink environment validation failed with ${issues.length} problem(s); missing/invalid keys: ${keyNames} (values are never included)`,
        { reason: "ENV_INVALID", details: issues },
      ),
    };
  }

  const env = new RoamLinkEnv({
    nodeEnv,
    roamlinkApiBaseUrl: values.get("ROAMLINK_API_BASE_URL") ?? "",
    roamlinkPublicApiUrl: values.get("ROAMLINK_PUBLIC_API_URL") ?? "",
    databaseUrl: values.get("DATABASE_URL") ?? "",
    redisUrl: values.get("REDIS_URL") ?? "",
    adcosApiBaseUrl: values.get("ADCOS_API_BASE_URL") ?? "",
    adcosApiVersion: (values.get("ADCOS_API_VERSION") as AdcosApiVersion | undefined) ?? ADCOS_API_VERSION_DEFAULT,
    adcosClientId: values.get("ADCOS_CLIENT_ID") ?? "",
    adcosClientSecret: values.get("ADCOS_CLIENT_SECRET") ?? "",
    adcosWebhookSecret: values.get("ADCOS_WEBHOOK_SECRET") ?? "",
  });
  return { ok: true, env };
}
