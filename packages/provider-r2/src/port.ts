/**
 * The object-storage PORT (RL-098).
 *
 * spec/deployment.md §2/§8 + ADR-0003: Cloudflare R2 is object storage for
 * LARGE artifacts (support attachments, diagnostic exports, user-
 * downloadable reports, large non-relational evidence, encrypted backup
 * artifacts). It is NEVER relational authority and never a source of
 * truth for business state - the port shape enforces that by construction:
 *
 *  - closed operation set: put / get / delete / list / presign (no query,
 *    no append, no SQL-ish surface - this is a blob bucket, not a
 *    database);
 *  - keys are validated against the RoamLink key convention (safe
 *    lowercase path segments, no traversal, namespaced);
 *  - object bodies are admitted only under a configurable size bound
 *    (bounded admission discipline);
 *  - presigned URLs are bounded in time (explicit expiry).
 */
import { ValidationError, type ErrorDetail } from "@roamlink/contracts";

/** Default per-object admission bound (bytes): 100 MiB. */
export const DEFAULT_MAX_OBJECT_BYTES = 104_857_600;

/** Default presign expiry bound: 1 hour. */
export const DEFAULT_MAX_PRESIGN_TTL_MS = 3_600_000;

/**
 * The RoamLink object-key convention: lowercase safe path segments,
 * forward-slash separated, no leading/trailing slash, no traversal,
 * 3-512 chars.
 */
export const OBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}(\/[a-z0-9][a-z0-9._-]{0,127}){0,31}$/;

export function validateObjectKey(key: string): string {
  if (typeof key !== "string" || !OBJECT_KEY_PATTERN.test(key) || key.includes("..")) {
    throw new ValidationError(
      "object keys must follow the RoamLink convention: lowercase [a-z0-9._-] segments separated by '/', 3-512 chars, no '..' traversal",
      {
        reason: "OBJECT_KEY_INVALID",
        details: [{ path: "key", issue: "violates the key convention" }],
      },
    );
  }
  return key;
}

export interface ObjectPutRequest {
  readonly key: string;
  /** Object body (bytes). */
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  /** Bounded, non-secret metadata (never credentials - RL-LOCK-016). */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ObjectPutResult {
  readonly key: string;
  readonly etag: string;
  readonly sizeBytes: number;
}

export interface ObjectGetResult {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly etag: string;
  readonly sizeBytes: number;
}

export interface ObjectListOptions {
  readonly prefix?: string;
  readonly maxKeys?: number;
  readonly cursor?: string;
}

export interface ObjectListPage {
  readonly keys: readonly { readonly key: string; readonly sizeBytes: number; readonly etag: string }[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export type PresignOperation = "get" | "put";

export interface PresignRequest {
  readonly key: string;
  readonly operation: PresignOperation;
  /** Presign lifetime in ms (bounded by the adapter's max). */
  readonly expiresInMs: number;
}

/**
 * The object-storage port. Implementations: the in-memory fake and the
 * S3-compatible R2 client - the contract battery proves port-parity.
 */
export interface ObjectStoragePort {
  put(request: ObjectPutRequest): Promise<ObjectPutResult>;
  /** Null when the object does not exist (absence is a valid answer). */
  get(key: string): Promise<ObjectGetResult | null>;
  /** True when something was deleted. */
  delete(key: string): Promise<boolean>;
  list(options?: ObjectListOptions): Promise<ObjectListPage>;
  /** Bounded-time presigned URL for direct browser/service transfers. */
  presign(request: PresignRequest): Promise<URL>;
}

export interface ObjectStorageBounds {
  readonly maxObjectBytes: number;
  readonly maxPresignTtlMs: number;
}

export const DEFAULT_OBJECT_STORAGE_BOUNDS: Readonly<ObjectStorageBounds> = Object.freeze({
  maxObjectBytes: DEFAULT_MAX_OBJECT_BYTES,
  maxPresignTtlMs: DEFAULT_MAX_PRESIGN_TTL_MS,
});

export function parseObjectStorageBounds(input?: Partial<ObjectStorageBounds>): ObjectStorageBounds {
  const bounds = { ...DEFAULT_OBJECT_STORAGE_BOUNDS, ...input };
  if (!Number.isInteger(bounds.maxObjectBytes) || bounds.maxObjectBytes < 1 || bounds.maxObjectBytes > 5_368_709_120) {
    throw new ValidationError("maxObjectBytes must be an integer between 1 and 5368709120", {
      reason: "OBJECT_BOUNDS_INVALID",
      details: [{ path: "maxObjectBytes", issue: "out of bounds" }],
    });
  }
  if (!Number.isInteger(bounds.maxPresignTtlMs) || bounds.maxPresignTtlMs < 1_000 || bounds.maxPresignTtlMs > 86_400_000) {
    throw new ValidationError("maxPresignTtlMs must be an integer between 1000 and 86400000", {
      reason: "OBJECT_BOUNDS_INVALID",
      details: [{ path: "maxPresignTtlMs", issue: "out of bounds" }],
    });
  }
  return Object.freeze({ ...bounds });
}

function issue(path: string, problem: string): ErrorDetail {
  return { path, issue: problem };
}

export function validateBodySize(body: Uint8Array | string, maxObjectBytes: number): Uint8Array {
  let bytes: Uint8Array;
  if (typeof body === "string") {
    bytes = Buffer.from(body, "utf8");
  } else if (body instanceof Uint8Array) {
    bytes = body;
  } else {
    throw new ValidationError("object bodies must be a string or Uint8Array", {
      reason: "OBJECT_BODY_INVALID",
      details: [issue("body", "unsupported type")],
    });
  }
  if (bytes.byteLength > maxObjectBytes) {
    throw new ValidationError(
      `object bodies are admitted only up to ${maxObjectBytes} bytes (bounded admission; large artifacts are the R2 lane, oversized ones are an operator decision)`,
      {
        reason: "OBJECT_BODY_TOO_LARGE",
        details: [issue("body", "exceeds the admission bound")],
      },
    );
  }
  return bytes;
}

const METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METADATA_VALUE_PATTERN = /^[\x20-\x7e]{0,256}$/;
const MAX_METADATA_ENTRIES = 16;

/** Validates user metadata: bounded, printable, non-secret-shaped (RL-LOCK-016). */
export function validateMetadata(metadata: Readonly<Record<string, string>> | undefined): void {
  if (metadata === undefined) return;
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new ValidationError(`object metadata is admitted only up to ${MAX_METADATA_ENTRIES} entries`, {
      reason: "OBJECT_METADATA_INVALID",
      details: [issue("metadata", "too many entries")],
    });
  }
  for (const [name, value] of entries) {
    if (!METADATA_KEY_PATTERN.test(name) || !METADATA_VALUE_PATTERN.test(value)) {
      throw new ValidationError(
        "object metadata must be lowercase [a-z0-9-] keys with printable values (max 256 chars); credentials are never metadata",
        {
          reason: "OBJECT_METADATA_INVALID",
          details: [issue("metadata", `entry '${name}' violates the metadata convention`)],
        },
      );
    }
  }
}
