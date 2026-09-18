/**
 * Fail-closed environment access for the R2 path (RL-098).
 *
 * Keys (deployment.md §6): R2_ACCOUNT_ID + R2_ACCESS_KEY_ID +
 * R2_SECRET_ACCESS_KEY (secret) + R2_BUCKET, with R2_ENDPOINT as an
 * optional override (e.g. a dedicated endpoint). The S3 endpoint derives
 * as `https://<accountId>.r2.cloudflarestorage.com`. Secrets live in
 * private fields, redacted from every stringification (RL-LOCK-016).
 */
import { ValidationError } from "@roamlink/contracts";
import { inspect } from "node:util";

export const R2_ENV_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT",
] as const;

export type R2EnvSource = Readonly<Record<string, string | undefined>>;

export type ParseR2EnvResult =
  | { readonly ok: true; readonly config: R2Env }
  | { readonly ok: false; readonly error: ValidationError };

/** Validated, secret-redacting R2 env config. */
export class R2Env {
  readonly accountId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;

  /** Not meant for direct use - construct via `tryParseR2Env`. */
  constructor(init: {
    readonly accountId: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly endpoint?: string;
  }) {
    this.accountId = init.accountId;
    this.bucket = init.bucket;
    this.endpoint = init.endpoint ?? `https://${init.accountId}.r2.cloudflarestorage.com`;
    this.#accessKeyId = init.accessKeyId;
    this.#secretAccessKey = init.secretAccessKey;
    Object.freeze(this);
  }

  get accessKeyId(): string {
    return this.#accessKeyId;
  }

  get secretAccessKey(): string {
    return this.#secretAccessKey;
  }

  toString(): string {
    return `R2Env(endpoint=${this.endpoint}, bucket=${this.bucket}, accessKeyId=[REDACTED], secretAccessKey=[REDACTED])`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function issue(path: string, problem: string): { path: string; issue: string } {
  return { path, issue: problem };
}

/**
 * Reads and validates R2 credentials. Missing keys fail with a value-free
 * error NAMING the key. Note: an R2 config is REQUIRED only for hosts
 * that expose artifact surfaces; environments without R2 leave the keys
 * unset and do not compose the storage adapter.
 */
export function tryParseR2Env(source: R2EnvSource): ParseR2EnvResult {
  const issues: { path: string; issue: string }[] = [];

  const accountId = source["R2_ACCOUNT_ID"];
  if (accountId === undefined || accountId.trim() === "") {
    issues.push(issue("R2_ACCOUNT_ID", "required when object storage is configured"));
  } else if (!/^[0-9a-f]{32}$/.test(accountId)) {
    issues.push(issue("R2_ACCOUNT_ID", "must be the 32-hex Cloudflare account id"));
  }

  const accessKeyId = source["R2_ACCESS_KEY_ID"];
  if (accessKeyId === undefined || accessKeyId.trim() === "") {
    issues.push(issue("R2_ACCESS_KEY_ID", "required when object storage is configured"));
  } else if (!/^[\x21-\x7e]+$/.test(accessKeyId) || accessKeyId.length > 256) {
    issues.push(issue("R2_ACCESS_KEY_ID", "must be printable non-whitespace ASCII (max 256 chars)"));
  }

  const secretAccessKey = source["R2_SECRET_ACCESS_KEY"];
  if (secretAccessKey === undefined || secretAccessKey.trim() === "") {
    issues.push(issue("R2_SECRET_ACCESS_KEY", "required when object storage is configured"));
  } else if (!/^[\x21-\x7e]+$/.test(secretAccessKey) || secretAccessKey.length > 256) {
    issues.push(issue("R2_SECRET_ACCESS_KEY", "must be printable non-whitespace ASCII (max 256 chars)"));
  }

  const bucket = source["R2_BUCKET"];
  if (bucket === undefined || bucket.trim() === "") {
    issues.push(issue("R2_BUCKET", "required when object storage is configured"));
  } else if (!/^[a-z0-9][a-z0-9-]{1,61}$/.test(bucket)) {
    issues.push(issue("R2_BUCKET", "must be a lowercase safe name (3-63 chars, [a-z0-9-])"));
  }

  const endpoint = source["R2_ENDPOINT"];
  if (endpoint !== undefined && endpoint.trim() !== "") {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:") issues.push(issue("R2_ENDPOINT", "must be an https URL"));
    } catch {
      issues.push(issue("R2_ENDPOINT", "must be an absolute https URL"));
    }
  }

  if (issues.length > 0) {
    const names = issues.map((detail) => detail.path).join(", ");
    return {
      ok: false,
      error: new ValidationError(
        `R2 environment validation failed with ${issues.length} problem(s); missing/invalid keys: ${names} (values are never included)`,
        { reason: "R2_ENV_INVALID", details: issues },
      ),
    };
  }

  return {
    ok: true,
    config: new R2Env({
      accountId: accountId as string,
      bucket: bucket as string,
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
      ...(endpoint !== undefined && endpoint.trim() !== "" ? { endpoint } : {}),
    }),
  };
}
