/**
 * AWS Signature Version 4 primitives (RL-098) - the ONE signing site for
 * the S3-compatible R2 client.
 *
 * Dependency-free (node:crypto only), fully deterministic, and anchored
 * in tests against the AWS documentation's published SigV4 example
 * (examplebucket GET test.txt, 20130524) so correctness is pinned to a
 * KNOWN vector rather than to itself.
 *
 * Secret hygiene (RL-LOCK-016): signing keys never appear in errors or
 * stringifications produced here.
 */
import { createHash, createHmac } from "node:crypto";

export const AWS4_ALGORITHM = "AWS4-HMAC-SHA256";
export const AWS4_REQUEST_SUFFIX = "aws4_request";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * MD5 hex digest — the S3-compatible ETag convention. The live R2 wire
 * (confirmed by the PA-012 operator-phase run) returns the MD5 of the
 * stored bytes as the ETag of a single-part PUT/GET and inside
 * ListObjectsV2 `<ETag>` elements; this helper pins that wire law in one
 * place for the client, the fakes and the contract battery.
 */
export function md5Hex(data: string | Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Derives the SigV4 signing key: secret -> date -> region -> service. */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, AWS4_REQUEST_SUFFIX);
}

/** URI-encodes per SigV4 rules (RFC 3986 unreserved = A-Za-z0-9 - _ . ~). */
export function awsUriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch;
    } else if (ch === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      const bytes = Buffer.from(ch, "utf8");
      for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export interface CanonicalQuery {
  readonly [name: string]: string;
}

/** Builds the canonical query string (sorted by key, URI-encoded). */
export function buildCanonicalQueryString(query: CanonicalQuery): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${awsUriEncode(name)}=${awsUriEncode(query[name] ?? "")}`)
    .join("&");
}

export interface CanonicalRequestInput {
  readonly method: string;
  /** Canonical URI (each segment URI-encoded; for S3: /bucket/key). */
  readonly canonicalUri: string;
  readonly canonicalQuery: string;
  /** Header map (lowercased names, trimmed values). */
  readonly headers: Readonly<Record<string, string>>;
  /** Sorted, semicolon-joined lowercase header names that are signed. */
  readonly signedHeaders: string;
  /** Hex sha-256 of the payload (or UNSIGNED-PAYLOAD for presigned PUT). */
  readonly payloadHash: string;
}

/** Builds the canonical request string. */
export function buildCanonicalRequest(input: CanonicalRequestInput): string {
  return [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    `${input.signedHeaders
      .split(";")
      .map((name) => `${name}:${(input.headers[name] ?? "").trim()}`)
      .join("\n")}\n`,
    input.signedHeaders,
    input.payloadHash,
  ].join("\n");
}

/** Builds the string-to-sign from the canonical request. */
export function buildStringToSign(amzDate: string, scope: string, canonicalRequest: string): string {
  return [AWS4_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
}

/** Scope: date/region/service/aws4_request. */
export function buildScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/${AWS4_REQUEST_SUFFIX}`;
}

/** Computes the final hex signature. */
export function computeSignature(signingKey: Buffer, stringToSign: string): string {
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}

export interface SigV4HeaderAuth {
  readonly authorizationHeader: string;
  readonly amzDate: string;
  readonly payloadHash: string;
}

export interface SigV4HeaderAuthInput {
  readonly method: string;
  /** Full path: /bucket/key (already canonical). */
  readonly path: string;
  readonly query: CanonicalQuery;
  readonly host: string;
  readonly body: Uint8Array | string;
  /** `yyyyMMddThhmmssZ`. */
  readonly amzDate: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly contentType?: string;
}

/** Signs a request with header-based auth (the client's PUT/GET/DELETE/LIST). */
export function signHeaderAuth(input: SigV4HeaderAuthInput): SigV4HeaderAuth {
  const dateStamp = input.amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": input.amzDate,
  };
  if (input.contentType !== undefined) headers["content-type"] = input.contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = buildCanonicalRequest({
    method: input.method,
    canonicalUri: input.path.split("/").map((segment) => awsUriEncode(segment, false)).join("/"),
    canonicalQuery: buildCanonicalQueryString(input.query),
    headers,
    signedHeaders,
    payloadHash,
  });
  const scope = buildScope(dateStamp, input.region, input.service);
  const stringToSign = buildStringToSign(input.amzDate, scope, canonicalRequest);
  const signingKey = deriveSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = computeSignature(signingKey, stringToSign);
  return {
    amzDate: input.amzDate,
    payloadHash,
    authorizationHeader: `${AWS4_ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface SigV4PresignResult {
  readonly url: URL;
}

export interface SigV4PresignInput {
  readonly method: "GET" | "PUT";
  readonly host: string;
  readonly path: string;
  /** `yyyyMMddThhmmssZ`. */
  readonly amzDate: string;
  /** Expiry in SECONDS (SigV4 X-Amz-Expires). */
  readonly expiresSeconds: number;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Builds a presigned URL (SigV4 query auth, UNSIGNED-PAYLOAD for PUT). */
export function presignUrl(input: SigV4PresignInput): SigV4PresignResult {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = buildScope(dateStamp, input.region, input.service);
  const payloadHash = input.method === "PUT" ? "UNSIGNED-PAYLOAD" : "UNSIGNED-PAYLOAD";
  const query: Record<string, string> = {
    "X-Amz-Algorithm": AWS4_ALGORITHM,
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": input.amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = buildCanonicalQueryString(query);
  const canonicalRequest = buildCanonicalRequest({
    method: input.method,
    canonicalUri: input.path.split("/").map((segment) => awsUriEncode(segment, false)).join("/"),
    canonicalQuery,
    headers: { host: input.host },
    signedHeaders: "host",
    payloadHash,
  });
  const stringToSign = buildStringToSign(input.amzDate, scope, canonicalRequest);
  const signingKey = deriveSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = computeSignature(signingKey, stringToSign);
  const url = new URL(`https://${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signature}`);
  return { url };
}
