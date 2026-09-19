/**
 * SigV4 correctness tests (RL-098): the implementation is anchored to the
 * AWS documentation's PUBLISHED SigV4 example vector (examplebucket GET
 * test.txt, 20130524, signature
 * f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41) so
 * the signing primitives are pinned to a known external truth, not to
 * themselves. The client/server parity tests then prove the wire path
 * end-to-end.
 */
import { describe, expect, it } from "vitest";
import {
  buildCanonicalQueryString,
  buildCanonicalRequest,
  buildScope,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
  signHeaderAuth,
  sha256Hex,
  presignUrl,
} from "../src/index.js";

describe("AWS SigV4 primitives (RL-098, anchored to the AWS docs vector)", () => {
  // The AWS documentation example (docs.aws.amazon.com general reference,
  // "Signature Calculations for the Authorization Header": GET test.txt).
  const AMZ_DATE = "20130524T000000Z";
  const SCOPE = "20130524/us-east-1/s3/aws4_request";
  const PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const EXPECTED_SIGNATURE = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";

  it("reproduces the published signature for the canonical GET example", () => {
    const canonicalRequest = buildCanonicalRequest({
      method: "GET",
      canonicalUri: "/test.txt",
      canonicalQuery: "",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": PAYLOAD_HASH,
        "x-amz-date": AMZ_DATE,
      },
      signedHeaders: "host;range;x-amz-content-sha256;x-amz-date",
      payloadHash: PAYLOAD_HASH,
    });
    const stringToSign = buildStringToSign(AMZ_DATE, SCOPE, canonicalRequest);
    const signingKey = deriveSigningKey("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20130524", "us-east-1", "s3");
    const signature = computeSignature(signingKey, stringToSign);
    expect(signature).toBe(EXPECTED_SIGNATURE);
  });

  it("produces a scope in the documented shape", () => {
    expect(buildScope("20130524", "us-east-1", "s3")).toBe(SCOPE);
  });

  it("canonicalizes queries sorted and URI-encoded", () => {
    expect(
      buildCanonicalQueryString({ "list-type": "2", prefix: "exports/org 1", "max-keys": "2" }),
    ).toBe("list-type=2&max-keys=2&prefix=exports%2Forg%201");
  });

  it("signs header auth deterministically (same inputs -> same signature)", () => {
    const input = {
      method: "PUT",
      path: "/roamlink-bucket/exports/org-1/2026/01/abcd1234abcd1234-file.bin",
      query: {},
      host: "account123.r2.cloudflarestorage.com",
      body: "payload-bytes",
      amzDate: "20260115T100000Z",
      region: "auto",
      service: "s3",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret-key-test",
      contentType: "application/octet-stream",
    };
    const first = signHeaderAuth(input);
    const second = signHeaderAuth(input);
    expect(first.authorizationHeader).toBe(second.authorizationHeader);
    expect(first.authorizationHeader).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260115\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(first.payloadHash).toBe(sha256Hex("payload-bytes"));
  });

  it("presigns query-auth URLs with UNSIGNED-PAYLOAD and bounded expiry", () => {
    const { url } = presignUrl({
      method: "PUT",
      host: "account123.r2.cloudflarestorage.com",
      path: "/roamlink-bucket/exports/org-1/2026/01/abcd1234abcd1234-file.bin",
      amzDate: "20260115T100000Z",
      expiresSeconds: 900,
      region: "auto",
      service: "s3",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret-key-test",
    });
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
  });

  it("changes the signature when any signed input changes", () => {
    const base = {
      method: "GET" as const,
      path: "/b/k.txt",
      query: {},
      host: "account.r2.cloudflarestorage.com",
      body: "",
      amzDate: "20260115T100000Z",
      region: "auto",
      service: "s3",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret-key-test",
    };
    const a = signHeaderAuth(base);
    const b = signHeaderAuth({ ...base, amzDate: "20260115T100001Z" });
    const c = signHeaderAuth({ ...base, secretAccessKey: "OTHER-SECRET" });
    expect(a.authorizationHeader).not.toBe(b.authorizationHeader);
    expect(a.authorizationHeader).not.toBe(c.authorizationHeader);
  });
});
