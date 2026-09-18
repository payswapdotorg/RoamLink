/**
 * Neon connection-string configuration surface (RL-095).
 *
 * DATABASE_URL discipline (spec/deployment.md §6): the durable PostgreSQL
 * source of truth is Neon; the connection string is the ONLY way this
 * package points at it. Parsing FAILS CLOSED with typed, value-free errors
 * (RL-LOCK-016: connection strings embed credentials and must never appear
 * in error messages, logs or health details).
 *
 * Encoded policy (deployment.md §5 "Neon should use scale-to-zero and
 * conservative compute"):
 *  - the endpoint MUST present a TLS sslmode (require | verify-ca |
 *    verify-full); `disable`/`allow`/`prefer` are rejected - plaintext
 *    credential transport is never a valid Neon configuration;
 *  - pooled vs direct endpoints are CLASSIFIED (Neon `-pooler` host suffix)
 *    so the host can pick pooled for serverless request paths and direct
 *    for migrations/long workers - the classification is documentation of
 *    intent, NOT a correctness claim;
 *  - pool sizing helpers return CONSERVATIVE defaults documented as
 *    operational guidance (free-tier compute is modest); quotas are never
 *    encoded into correctness logic (handoff §12 stop-rule).
 */
import { ValidationError, type ErrorDetail } from "@roamlink/contracts";

/** The only supported PostgreSQL URL schemes for the Neon driver path. */
export const NEON_URL_SCHEMES = ["postgres:", "postgresql:"] as const;

/** Neon pooled endpoints carry the `-pooler` host suffix. */
export const NEON_POOLER_HOST_SUFFIX = "-pooler";

/** Closed vocabulary of accepted sslmode values (TLS enforced). */
export const NEON_ACCEPTED_SSLMODES = ["require", "verify-ca", "verify-full"] as const;

export type NeonSslMode = (typeof NEON_ACCEPTED_SSLMODES)[number];

/** The closed, validated shape of a Neon DATABASE_URL (no secret accessors). */
export interface NeonConnectionConfig {
  /** e.g. `ep-cool-name-a1b2c3d4` or its `-pooler` variant. */
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** True when the endpoint is a Neon pooled endpoint. */
  readonly pooledEndpoint: boolean;
  readonly sslMode: NeonSslMode;
  /** Optional `application_name` query parameter (never a credential). */
  readonly applicationName?: string;
}

export interface ParseNeonConnectionStringResult {
  readonly ok: true;
  readonly config: NeonConnectionConfig;
}

const MAX_CONNECTION_STRING_LENGTH = 2048;

function issue(path: string, problem: string): ErrorDetail {
  return { path, issue: problem };
}

function isNeonSslMode(value: string): value is NeonSslMode {
  return (NEON_ACCEPTED_SSLMODES as readonly string[]).includes(value);
}

/**
 * Parses and validates a Neon PostgreSQL connection string. NEVER include
 * the returned config in logs: the parse result intentionally keeps only
 * non-credential members (the password is dropped, not stored).
 */
export function parseNeonConnectionString(
  raw: string,
): ParseNeonConnectionStringResult | { ok: false; error: ValidationError } {
  const issues: ErrorDetail[] = [];

  if (typeof raw !== "string" || raw.length === 0) {
    return {
      ok: false,
      error: new ValidationError(
        "the Neon connection string must be a non-empty string (DATABASE_URL)",
        { reason: "NEON_CONNECTION_INVALID", details: [issue("connectionString", "empty or not a string")] },
      ),
    };
  }
  if (raw.length > MAX_CONNECTION_STRING_LENGTH) {
    issues.push(issue("connectionString", `must be at most ${MAX_CONNECTION_STRING_LENGTH} chars`));
  }
  if (/\s/.test(raw)) {
    issues.push(issue("connectionString", "must not contain whitespace"));
  }
  if (issues.length > 0) {
    return fail(issues);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail([issue("connectionString", "must be an absolute URL (postgres:// or postgresql://)")]);
  }

  if (!(NEON_URL_SCHEMES as readonly string[]).includes(url.protocol)) {
    issues.push(issue("protocol", "must be postgres:// or postgresql://"));
  }
  if (url.hostname.length === 0) {
    issues.push(issue("host", "required (the Neon endpoint host)"));
  }
  if (url.username.length === 0) {
    issues.push(issue("user", "required (the Neon role name)"));
  }
  if (url.password.length === 0) {
    issues.push(issue("password", "required (Neon role password; provide it via the environment, never in code)"));
  }
  const database = url.pathname.replace(/^\//, "");
  if (database.length === 0) {
    issues.push(issue("database", "required (the Neon database name in the path)"));
  }

  const sslModeRaw = url.searchParams.get("sslmode");
  if (sslModeRaw === null) {
    issues.push(issue("sslmode", "required for the Neon driver path (use require, verify-ca or verify-full)"));
  } else if (!isNeonSslMode(sslModeRaw)) {
    issues.push(issue("sslmode", "must be one of: require, verify-ca, verify-full (plaintext modes are rejected)"));
  }

  if (url.searchParams.has("password")) {
    issues.push(issue("password", "must never be supplied as a query parameter"));
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  const host = url.hostname;
  const port = url.port.length > 0 ? Number(url.port) : 5432;
  const applicationNameRaw = url.searchParams.get("application_name");
  const config: NeonConnectionConfig = {
    host,
    port,
    database,
    // Neon pooled endpoints embed the `-pooler` label as a DNS label inside
    // the host, e.g. `ep-name-a1b2c3d4-pooler.eu-central-1.aws.neon.tech`.
    pooledEndpoint: host.split(".").some((label) => label.endsWith(NEON_POOLER_HOST_SUFFIX)),
    sslMode: sslModeRaw as NeonSslMode,
    ...(applicationNameRaw !== null && applicationNameRaw.length > 0
      ? { applicationName: applicationNameRaw }
      : {}),
  };
  return { ok: true, config };
}

function fail(issues: readonly ErrorDetail[]): { ok: false; error: ValidationError } {
  return {
    ok: false,
    error: new ValidationError(
      `the Neon connection string is not a valid DATABASE_URL for the Neon driver path (${issues.length} problem(s); values are never included)`,
      { reason: "NEON_CONNECTION_INVALID", details: issues },
    ),
  };
}

// --------------------------------------------------------------------------------
// Pool configuration guidance
// --------------------------------------------------------------------------------

/** Conservative pool guidance for the Neon free-tier driver path. */
export interface NeonPoolOptions {
  /** Max connections per compute instance (serverless: stay LOW). */
  readonly maxConnections: number;
  /** Idle connection reaping in ms. */
  readonly idleTimeoutMs: number;
  /** Connect timeout in ms (fail fast, scale-to-zero cold starts are real). */
  readonly connectTimeoutMs: number;
}

export const NEON_POOL_DEFAULTS: Readonly<NeonPoolOptions> = Object.freeze({
  maxConnections: 5,
  idleTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
});

export const NEON_POOL_BOUNDS = Object.freeze({
  maxConnections: { min: 1, max: 100 },
  idleTimeoutMs: { min: 1_000, max: 3_600_000 },
  connectTimeoutMs: { min: 1_000, max: 60_000 },
} as const);

/**
 * Resolves pool options over the documented conservative defaults. This is
 * OPERATIONAL GUIDANCE for the driver path (deployment.md §5), not
 * correctness logic: a provider quota change is a runbook concern, never a
 * behavioral branch.
 */
export function resolveNeonPoolOptions(overrides?: Partial<NeonPoolOptions>): NeonPoolOptions {
  const resolved: NeonPoolOptions = { ...NEON_POOL_DEFAULTS, ...overrides };
  const bounds = NEON_POOL_BOUNDS;
  for (const key of ["maxConnections", "idleTimeoutMs", "connectTimeoutMs"] as const) {
    const value = resolved[key];
    const bound = bounds[key];
    if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
      throw new ValidationError(
        `Neon pool option '${key}' must be an integer between ${bound.min} and ${bound.max}`,
        {
          reason: "NEON_POOL_CONFIG_INVALID",
          details: [{ path: key, issue: "out of documented bounds" }],
        },
      );
    }
  }
  return Object.freeze({ ...resolved });
}

// --------------------------------------------------------------------------------
// Redaction (RL-LOCK-016)
// --------------------------------------------------------------------------------

/**
 * Renders a connection string safe for logs/diagnostics: the password is
 * replaced by a marker and any `sslpassword`-style query value is masked.
 * The output remains a valid-shaped URL for support tickets.
 */
export function redactNeonConnectionString(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[unparseable-connection-string]";
  }
  if (url.password.length > 0) {
    url.password = "[REDACTED]";
  }
  if (url.searchParams.has("sslpassword")) {
    url.searchParams.set("sslpassword", "[REDACTED]");
  }
  if (url.searchParams.has("password")) {
    url.searchParams.set("password", "[REDACTED]");
  }
  return url.toString();
}
