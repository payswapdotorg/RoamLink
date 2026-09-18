/**
 * The in-memory object-storage fake (RL-098): deterministic, bounded,
 * no network. Used for tests and local development - never durable state
 * (the durable source of truth stays Neon/PostgreSQL; R2 holds artifacts).
 */
import { createHash } from "node:crypto";
import { ValidationError } from "@roamlink/contracts";
import {
  type ObjectGetResult,
  type ObjectListPage,
  type ObjectPutResult,
  type ObjectStoragePort,
  type PresignRequest,
  type ObjectStorageBounds,
  parseObjectStorageBounds,
  validateBodySize,
  validateMetadata,
  validateObjectKey,
} from "./port.js";

export interface InMemoryObjectStorageOptions {
  readonly bounds?: Partial<ObjectStorageBounds>;
  /** Presign authority for the fake (validates signatures in tests). */
  readonly presignSecret?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
  etag: string;
}

export class InMemoryObjectStorage implements ObjectStoragePort {
  readonly #objects = new Map<string, StoredObject>();
  readonly #bounds: ObjectStorageBounds;
  readonly #presignSecret: InMemoryObjectStorageOptions["presignSecret"];

  constructor(options?: InMemoryObjectStorageOptions) {
    this.#bounds = parseObjectStorageBounds(options?.bounds);
    this.#presignSecret = options?.presignSecret;
  }

  async put(request: Parameters<ObjectStoragePort["put"]>[0]): Promise<ObjectPutResult> {
    validateObjectKey(request.key);
    const bytes = validateBodySize(request.body, this.#bounds.maxObjectBytes);
    validateMetadata(request.metadata);
    const etag = createHash("sha256").update(bytes).digest("hex");
    this.#objects.set(request.key, {
      body: bytes,
      ...(request.contentType !== undefined ? { contentType: request.contentType } : {}),
      ...(request.metadata !== undefined ? { metadata: Object.freeze({ ...request.metadata }) } : {}),
      etag,
    });
    return { key: request.key, etag, sizeBytes: bytes.byteLength };
  }

  async get(key: string): Promise<ObjectGetResult | null> {
    validateObjectKey(key);
    const object = this.#objects.get(key);
    if (object === undefined) return null;
    return {
      body: new Uint8Array(object.body),
      ...(object.contentType !== undefined ? { contentType: object.contentType } : {}),
      etag: object.etag,
      sizeBytes: object.body.byteLength,
    };
  }

  async delete(key: string): Promise<boolean> {
    validateObjectKey(key);
    return this.#objects.delete(key);
  }

  async list(options?: { prefix?: string; maxKeys?: number; cursor?: string }): Promise<ObjectListPage> {
    if (options?.maxKeys !== undefined && (!Number.isInteger(options.maxKeys) || options.maxKeys < 1 || options.maxKeys > 1000)) {
      throw new ValidationError("maxKeys must be an integer between 1 and 1000", {
        reason: "OBJECT_LIST_INVALID",
        details: [{ path: "maxKeys", issue: "out of bounds" }],
      });
    }
    const maxKeys = options?.maxKeys ?? 100;
    const prefix = options?.prefix ?? "";
    const sortedKeys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const startIndex = options?.cursor !== undefined ? Number(Buffer.from(options.cursor, "base64url").toString("utf8")) : 0;
    const page = sortedKeys.slice(startIndex, startIndex + maxKeys);
    const truncated = startIndex + maxKeys < sortedKeys.length;
    return {
      keys: page.map((key) => {
        const object = this.#objects.get(key);
        return { key, sizeBytes: object?.body.byteLength ?? 0, etag: object?.etag ?? "" };
      }),
      truncated,
      ...(truncated
        ? { nextCursor: Buffer.from(String(startIndex + maxKeys), "utf8").toString("base64url") }
        : {}),
    };
  }

  /**
   * Presigns against the configured signing secret (when present) so
   * presigned-URL tests can verify signature/expiry handling end-to-end.
   */
  async presign(request: PresignRequest): Promise<URL> {
    validateObjectKey(request.key);
    if (!Number.isInteger(request.expiresInMs) || request.expiresInMs < 1_000 || request.expiresInMs > this.#bounds.maxPresignTtlMs) {
      throw new ValidationError(
        `presign lifetimes must be integers between 1000 and ${this.#bounds.maxPresignTtlMs}ms (bounded presign discipline)`,
        {
          reason: "OBJECT_PRESIGN_INVALID",
          details: [{ path: "expiresInMs", issue: "out of bounds" }],
        },
      );
    }
    if (this.#presignSecret === undefined) {
      // Deterministic stand-in URL (no signing secret configured).
      return new URL(`https://fake-r2.local/${request.key}?expiresIn=${request.expiresInMs}&op=${request.operation}`);
    }
    const { presignUrl } = await import("./sigv4.js");
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const result = presignUrl({
      method: request.operation === "put" ? "PUT" : "GET",
      host: "fake-r2.local",
      path: `/${request.key}`,
      amzDate,
      expiresSeconds: Math.ceil(request.expiresInMs / 1000),
      region: "auto",
      service: "s3",
      accessKeyId: this.#presignSecret.accessKeyId,
      secretAccessKey: this.#presignSecret.secretAccessKey,
    });
    return result.url;
  }

  /** Test/telemetry snapshot. */
  get size(): number {
    return this.#objects.size;
  }
}
