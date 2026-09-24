/**
 * The in-memory S3-compatible server (RL-098 test harness).
 *
 * Speaks the pinned S3 REST subset (PUT/GET/DELETE + ListObjectsV2 XML)
 * and VALIDATES AWS SigV4 signatures - both header auth and presigned
 * query auth - by REBUILDING the canonical request from the raw wire
 * request. This proves the client's signing is correct end-to-end
 * (canonical request construction, header selection, payload hashing,
 * key derivation) without any dependency on the client's internals and
 * without any network.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { buildCanonicalQueryString, deriveSigningKey, md5Hex, sha256Hex } from "../src/index.js";

export interface S3ServerOptions {
  readonly bucket: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Injectable now (epoch ms) for presign expiry checks (deterministic tests). */
  readonly nowMs: () => number;
}

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
  etag: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly signatureValid: boolean;
}

export function createS3CompatibleServer(options: S3ServerOptions): {
  fetchLike: typeof fetch;
  objects: Map<string, StoredObject>;
  requests: RecordedRequest[];
} {
  const objects = new Map<string, StoredObject>();
  const requests: RecordedRequest[] = [];

  const fetchLike = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const prefix = `/${options.bucket}`;
    const key = path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path === prefix ? "" : null;

    const auth = new Headers(init?.headers).get("authorization");
    const isPresigned = url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256";
    let valid = false;
    if (isPresigned) {
      valid = verifyPresigned(url, method, options);
    } else if (auth !== null) {
      valid = verifyHeaderAuth(url, method, auth, init, options);
    }
    requests.push({ method, path, signatureValid: valid });
    if (!valid) return xmlResponse(403, { Code: "SignatureDoesNotMatch" });

    if (key === null) {
      return xmlResponse(404, { Code: "NoSuchBucket" });
    }

    if (method === "PUT" && key.length > 0) {
      const body = typeof init?.body === "string" ? Buffer.from(init.body, "utf8") : new Uint8Array((init?.body as ArrayBuffer | undefined) ?? new ArrayBuffer(0));
      const providedHash = new Headers(init?.headers).get("x-amz-content-sha256");
      if (providedHash !== null && providedHash !== "UNSIGNED-PAYLOAD" && providedHash !== sha256Hex(body)) {
        return xmlResponse(400, { Code: "BadDigest" });
      }
      // The fake models the LIVE R2 wire (PA-012): the single-part ETag is
      // the MD5 of the stored bytes.
      const etag = md5Hex(body);
      const contentType = new Headers(init?.headers).get("content-type") ?? undefined;
      objects.set(key, { body, etag, ...(contentType !== undefined ? { contentType } : {}) });
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
    }

    if (method === "GET" && key.length === 0) {
      // ListObjectsV2 (strict subset: prefix, max-keys, continuation-token)
      const listPrefix = url.searchParams.get("prefix") ?? "";
      const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
      const token = url.searchParams.get("continuation-token");
      const start = token !== null ? Number(Buffer.from(token, "base64url").toString("utf8")) : 0;
      const all = [...objects.keys()].filter((k) => k.startsWith(listPrefix)).sort();
      const page = all.slice(start, start + maxKeys);
      const truncated = start + maxKeys < all.length;
      const entries = page
        .map((k) => {
          const object = objects.get(k);
          return `<Contents><Key>${k}</Key><Size>${object?.body.byteLength ?? 0}</Size><ETag>&quot;${object?.etag ?? ""}&quot;</ETag></Contents>`;
        })
        .join("");
      const nextToken = truncated
        ? `<NextContinuationToken>${Buffer.from(String(start + maxKeys), "utf8").toString("base64url")}</NextContinuationToken>`
        : "";
      return xmlResponse(200, {
        // The real S3/R2 ListObjectsV2 root carries the xmlns declaration
        // (live-confirmed by PA-012) — the fake models the same wire shape.
        raw: `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${options.bucket}</Name><IsTruncated>${truncated}</IsTruncated>${nextToken}${entries}</ListBucketResult>`,
      });
    }

    if (method === "GET" && key.length > 0) {
      const object = objects.get(key);
      if (object === undefined) return xmlResponse(404, { Code: "NoSuchKey" });
      // The real edge may serve GETs of compressible content as a compressed
      // representation with a WEAK validator (W/"<md5>", live-confirmed by
      // PA-012) even though PUT answers strong — the fake models that form so
      // the client's etag normalization is pinned deterministically.
      return new Response(Buffer.from(object.body), {
        status: 200,
        headers: { etag: `W/"${object.etag}"`, ...(object.contentType !== undefined ? { "content-type": object.contentType } : {}) },
      });
    }

    if (method === "DELETE" && key.length > 0) {
      // The real S3/R2 wire (live-confirmed by PA-012): DeleteObject is
      // IDEMPOTENT-SUCCESS — an absent key also answers 204 (S3's documented
      // contract; absence is indistinguishable from deletion on the wire).
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return xmlResponse(400, { Code: "InvalidRequest" });
  }) as unknown as typeof fetch;

  return { fetchLike, objects, requests };
}

function verifyHeaderAuth(
  url: URL,
  method: string,
  authorization: string,
  init: RequestInit | undefined,
  options: S3ServerOptions,
): boolean {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
    authorization,
  );
  if (match === null) return false;
  const [, accessKeyId, dateStamp, region, service, signedHeadersRaw, signature] = match as unknown as [string, string, string, string, string, string, string, string];
  if (accessKeyId !== options.accessKeyId || region !== options.region || service !== options.service) return false;
  const headers = new Headers(init?.headers);
  const signedHeaders = signedHeadersRaw.split(";");
  const headerMap: Record<string, string> = {};
  for (const name of signedHeaders) {
    if (name === "host") {
      headerMap[name] = url.host;
    } else {
      const value = headers.get(name);
      if (value === null) return false;
      headerMap[name] = value;
    }
  }
  const payloadHash = headerMap["x-amz-content-sha256"] ?? sha256Hex(init?.body === undefined ? "" : (init.body as Uint8Array | string));
  const canonicalQuery = buildCanonicalQueryString(Object.fromEntries([...url.searchParams.entries()]));
  const canonicalUri = url.pathname;
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `${signedHeaders.map((name) => `${name}:${(headerMap[name] ?? "").trim()}`).join("\n")}\n`,
    signedHeadersRaw,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headerMap["x-amz-date"] ?? "",
    `${dateStamp}/${region}/${service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = deriveSigningKey(options.secretAccessKey, dateStamp, region, service);
  const expected = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyPresigned(url: URL, method: string, options: S3ServerOptions): boolean {
  const signature = url.searchParams.get("X-Amz-Signature");
  const credential = url.searchParams.get("X-Amz-Credential") ?? "";
  const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
  const expires = Number(url.searchParams.get("X-Amz-Expires") ?? "0");
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
  if (signature === null || signedHeaders !== "host") return false;
  const credMatch = /^([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request$/.exec(credential);
  if (credMatch === null) return false;
  const [, accessKeyId, dateStamp, region, service] = credMatch as unknown as [string, string, string, string, string, string];
  if (accessKeyId !== options.accessKeyId || region !== options.region || service !== options.service) return false;
  // expiry: amzDate + expires >= now (deterministic via the injected clock)
  const signedAtMs = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAtMs) || options.nowMs() > signedAtMs + expires * 1000) return false;
  const queryNoSignature: Record<string, string> = {};
  for (const [name, value] of url.searchParams.entries()) {
    if (name !== "X-Amz-Signature") queryNoSignature[name] = value;
  }
  const canonicalRequest = [
    method,
    url.pathname,
    buildCanonicalQueryString(queryNoSignature),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, `${dateStamp}/${region}/${service}/aws4_request`, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(options.secretAccessKey, dateStamp, region, service);
  const expected = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function xmlResponse(status: number, body: { Code?: string; raw?: string }): Response {
  const xml =
    body.raw ??
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${body.Code ?? "InternalError"}</Code></Error>`;
  return new Response(xml, { status, headers: { "content-type": "application/xml" } });
}
