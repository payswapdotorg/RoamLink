/**
 * The S3-compatible REST client (RL-098) - the hosted implementation of
 * the {@link ObjectStoragePort} against Cloudflare R2's S3-compatible API.
 *
 * Wire contract (single-site pin, live-confirmed by the PA-012
 * operator-phase run against a real R2 bucket):
 *  - endpoint `https://<accountId>.r2.cloudflarestorage.com`, bucket in
 *    the path (`/{bucket}/{key}`), service `s3`, region `auto`;
 *  - AWS SigV4 header auth for PUT/GET/DELETE and ListObjectsV2
 *    (`list-type=2`); SigV4 query (presigned) URLs for direct transfers;
 *  - the ETag of a single-part PUT/GET is the MD5 hex digest of the
 *    stored bytes (quoted on the header, `&quot;`-escaped in list XML) —
 *    NOT the sha-256 content digest; content addressing stays the KEY's
 *    job (the sha-256 rides the content-addressed key + the manifest);
 *  - GET of an absent object (404 + NoSuchKey XML) is a VALID answer
 *    (null), never an error - absence is a state, not a failure;
 *  - DELETE of an existing object answers 204;
 *  - ListObjectsV2's XML root carries the S3 xmlns declaration
 *    (`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`)
 *    and is parsed by a STRICT closed-shape parser
 *    (Key/Size/ETag/IsTruncated/NextContinuationToken only) that fails
 *    closed on anything unexpected;
 *  - provider failures surface as typed {@link S3ProviderError} with
 *    SUPPRESSED provider text (RL-LOCK-016).
 *
 * Wire note (AR-009, retired for the R2 leg by PA-012): the S3 REST
 * semantics above were originally pinned from the published S3/R2
 * documentation and an in-memory SigV4-validating server; the PA-012
 * operator-phase run confirmed them LIVE (signing, bucket addressing,
 * the md5 ETag law, the xmlns list envelope, 404/204 statuses) and the
 * two wrong assumptions it surfaced (sha-256-shaped ETags, an
 * xmlns-intolerant list envelope) were corrected in this client.
 */
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
import { presignUrl, md5Hex, signHeaderAuth } from "./sigv4.js";

export const R2_DEFAULT_REGION = "auto";
export const R2_SERVICE = "s3";

export type FetchLike = typeof fetch;

export interface S3ObjectStorageClientOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
  readonly fetchLike?: FetchLike;
  /** Injectable clock producing `yyyyMMddThhmmssZ` strings; defaults to system UTC. */
  readonly amzDateSource?: () => string;
  readonly bounds?: Partial<ObjectStorageBounds>;
  readonly timeoutMs?: number;
}

export class S3ProviderError extends Error {
  readonly status: number | null;
  readonly phase: "request-not-sent" | "response-unusable" | "provider-error";

  constructor(phase: "request-not-sent" | "response-unusable" | "provider-error", status: number | null, message: string) {
    super(message);
    this.phase = phase;
    this.status = status;
    this.name = "S3ProviderError";
    Object.freeze(this);
  }
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}$/;

/**
 * Normalizes a wire ETag header onto the port's etag semantic (the md5 hex
 * digest of the stored bytes): strips the optional weak-validator prefix
 * (`W/` — the live edge serves compressed representations with weak
 * validators, live-confirmed by PA-012) and the quoting. Null when the
 * provider sent no header at all.
 */
function normalizeWireEtag(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/^W\//, "").replace(/"/g, "");
}

function formatAmzDate(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export class S3ObjectStorageClient implements ObjectStoragePort {
  readonly #endpoint: URL;
  readonly #bucket: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #region: string;
  readonly #doFetch: FetchLike;
  readonly #amzDateSource: () => string;
  readonly #bounds: ObjectStorageBounds;
  readonly #timeoutMs: number;

  constructor(options: S3ObjectStorageClientOptions) {
    if (typeof options?.endpoint !== "string") {
      throw new ValidationError("S3ObjectStorageClient endpoint must be a string", {
        reason: "S3_CLIENT_CONFIG_INVALID",
        details: [{ path: "endpoint", issue: "missing" }],
      });
    }
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new ValidationError("S3ObjectStorageClient endpoint must be an absolute URL", {
        reason: "S3_CLIENT_CONFIG_INVALID",
        details: [{ path: "endpoint", issue: "not an absolute URL" }],
      });
    }
    if (endpoint.protocol !== "https:") {
      throw new ValidationError("S3ObjectStorageClient endpoint must be HTTPS (credentials on the wire)", {
        reason: "S3_CLIENT_CONFIG_INVALID",
        details: [{ path: "endpoint", issue: "not https" }],
      });
    }
    if (typeof options.bucket !== "string" || !BUCKET_PATTERN.test(options.bucket)) {
      throw new ValidationError("the bucket must be a lowercase safe name (3-63 chars, [a-z0-9-])", {
        reason: "S3_CLIENT_CONFIG_INVALID",
        details: [{ path: "bucket", issue: "invalid shape" }],
      });
    }
    for (const [path, value] of [
      ["accessKeyId", options.accessKeyId],
      ["secretAccessKey", options.secretAccessKey],
    ] as const) {
      if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value) || value.length > 256) {
        throw new ValidationError(`${path} must be printable non-whitespace ASCII (max 256 chars)`, {
          reason: "S3_CLIENT_CONFIG_INVALID",
          details: [{ path, issue: "invalid shape" }],
        });
      }
    }
    this.#endpoint = endpoint;
    this.#bucket = options.bucket;
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = options.secretAccessKey;
    this.#region = options.region ?? R2_DEFAULT_REGION;
    this.#doFetch = options.fetchLike ?? fetch;
    this.#amzDateSource = options.amzDateSource ?? (() => formatAmzDate(new Date()));
    this.#bounds = parseObjectStorageBounds(options.bounds);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) {
      throw new ValidationError("timeoutMs must be an integer between 1 and 120000", {
        reason: "S3_CLIENT_CONFIG_INVALID",
        details: [{ path: "timeoutMs", issue: "out of bounds" }],
      });
    }
  }

  async put(request: Parameters<ObjectStoragePort["put"]>[0]): Promise<ObjectPutResult> {
    validateObjectKey(request.key);
    validateMetadata(request.metadata);
    const bytes = validateBodySize(request.body, this.#bounds.maxObjectBytes);
    const response = await this.#signedRequest("PUT", request.key, bytes, request.contentType);
    // The live wire answers the MD5 of the stored bytes (S3 single-part
    // ETag law); the fallback models the same convention for hypothetical
    // etag-less responses so the port's etag stays ONE semantic everywhere.
    const etag = normalizeWireEtag(response.headers.get("etag")) ?? md5Hex(bytes);
    return { key: request.key, etag, sizeBytes: bytes.byteLength };
  }

  async get(key: string): Promise<ObjectGetResult | null> {
    validateObjectKey(key);
    const response = await this.#signedRequest("GET", key);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new S3ProviderError("provider-error", response.status, "the object GET failed (provider text suppressed)");
    }
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      body,
      ...(response.headers.get("content-type") !== null ? { contentType: response.headers.get("content-type") as string } : {}),
      etag: normalizeWireEtag(response.headers.get("etag")) ?? md5Hex(body),
      sizeBytes: body.byteLength,
    };
  }

  async delete(key: string): Promise<boolean> {
    validateObjectKey(key);
    const response = await this.#signedRequest("DELETE", key);
    if (response.status === 404) return false;
    if (response.status !== 204 && response.status !== 200) {
      throw new S3ProviderError("provider-error", response.status, "the object DELETE failed (provider text suppressed)");
    }
    return true;
  }

  async list(options?: { prefix?: string; maxKeys?: number; cursor?: string }): Promise<ObjectListPage> {
    const query: Record<string, string> = { "list-type": "2" };
    if (options?.prefix !== undefined) {
      query.prefix = options.prefix;
    }
    if (options?.maxKeys !== undefined) {
      if (!Number.isInteger(options.maxKeys) || options.maxKeys < 1 || options.maxKeys > 1000) {
        throw new ValidationError("maxKeys must be an integer between 1 and 1000", {
          reason: "OBJECT_LIST_INVALID",
          details: [{ path: "maxKeys", issue: "out of bounds" }],
        });
      }
      query["max-keys"] = String(options.maxKeys);
    }
    if (options?.cursor !== undefined) {
      query["continuation-token"] = options.cursor;
    }
    const response = await this.#signedRequest("GET", "", undefined, undefined, query);
    if (response.status !== 200) {
      throw new S3ProviderError("provider-error", response.status, "the object LIST failed (provider text suppressed)");
    }
    const xml = await response.text();
    return parseListBucketResult(xml);
  }

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
    const host = this.#endpoint.host;
    const path = `/${this.#bucket}/${request.key}`;
    const result = presignUrl({
      method: request.operation === "put" ? "PUT" : "GET",
      host,
      path,
      amzDate: this.#amzDateSource(),
      expiresSeconds: Math.ceil(request.expiresInMs / 1000),
      region: this.#region,
      service: R2_SERVICE,
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
    });
    return result.url;
  }

  /** Log-safe identity (credentials never included - RL-LOCK-016). */
  toString(): string {
    return `S3ObjectStorageClient(${this.#endpoint.host}/${this.#bucket})`;
  }

  async #signedRequest(
    method: "PUT" | "GET" | "DELETE",
    key: string,
    body?: Uint8Array,
    contentType?: string,
    query: Record<string, string> = {},
  ): Promise<Response> {
    const host = this.#endpoint.host;
    const path = key.length > 0 ? `/${this.#bucket}/${key}` : `/${this.#bucket}`;
    const amzDate = this.#amzDateSource();
    const signed = signHeaderAuth({
      method,
      path,
      query,
      host,
      body: body ?? "",
      amzDate,
      region: this.#region,
      service: R2_SERVICE,
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
      ...(contentType !== undefined ? { contentType } : {}),
    });
    const url = new URL(`${this.#endpoint.origin}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    try {
      const requestInit: RequestInit = {
        method,
        headers: {
          host,
          // The byte-storage client wants the IDENTITY representation: the
          // live edge compresses compressible content types when the client
          // advertises encoding support and then answers a WEAK validator
          // (W/"<md5>") for the compressed representation (live-confirmed by
          // PA-012). Identity keeps the transfer raw and the ETag strong;
          // `normalizeWireEtag` remains the safety net. Unsigned header — no
          // SigV4 canonicalization impact.
          "accept-encoding": "identity",
          "x-amz-content-sha256": signed.payloadHash,
          "x-amz-date": signed.amzDate,
          authorization: signed.authorizationHeader,
          ...(contentType !== undefined ? { "content-type": contentType } : {}),
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      };
      if (body !== undefined) requestInit.body = new Uint8Array(body).buffer as ArrayBuffer;
      return await this.#doFetch(url.toString(), requestInit);
    } catch {
      throw new S3ProviderError("request-not-sent", null, "the object-storage request did not complete (details suppressed)");
    }
  }
}

/**
 * STRICT ListObjectsV2 XML parser (closed shape): ListBucketResult (the
 * real S3/R2 root carries the xmlns declaration — tolerated as part of
 * the pinned wire shape) with IsTruncated, optional
 * NextContinuationToken and Contents entries of Key/Size/ETag only, the
 * ETag being the md5 hex digest the live wire returns. Anything else
 * fails closed (value-free).
 */
export function parseListBucketResult(xml: string): ObjectListPage {
  const envelope = /<ListBucketResult[^>]*>([\s\S]*)<\/ListBucketResult>/.exec(xml);
  if (envelope === null) {
    throw new S3ProviderError("response-unusable", null, "the LIST response is not a ListBucketResult document (failing closed)");
  }
  const truncatedMatch = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(envelope[1] ?? "");
  if (truncatedMatch === null) {
    throw new S3ProviderError("response-unusable", null, "the LIST response lacks IsTruncated (failing closed)");
  }
  const truncated = truncatedMatch[1] === "true";
  let nextCursor: string | undefined;
  if (truncated) {
    const tokenMatch = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(envelope[1] ?? "");
    if (tokenMatch === null) {
      throw new S3ProviderError("response-unusable", null, "a truncated LIST response lacks NextContinuationToken (failing closed)");
    }
    nextCursor = decodeXmlEntities(tokenMatch[1] ?? "");
  }
  const keys: { key: string; sizeBytes: number; etag: string }[] = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsPattern.exec(envelope[1] ?? "")) !== null) {
    const entry = match[1] ?? "";
    const key = /<Key>([^<]+)<\/Key>/.exec(entry)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(entry)?.[1];
    const etag = /<ETag>(?:W\/)?&?quot;?([0-9a-f]{32})&?quot;?<\/ETag>/.exec(entry)?.[1];
    if (key === undefined || size === undefined || etag === undefined) {
      throw new S3ProviderError("response-unusable", null, "a LIST Contents entry lacks Key/Size/ETag (failing closed)");
    }
    keys.push({ key: decodeXmlEntities(key), sizeBytes: Number(size), etag });
  }
  return { keys, truncated, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
