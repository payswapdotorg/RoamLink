/**
 * Port-parity contract tests (RL-098): the SAME battery runs against
 *  1. the in-memory fake, and
 *  2. the S3-compatible client over a SigV4-VALIDATING in-memory server
 *     (no network) - proving wire encoding, signing, XML list parsing and
 *     semantic parity.
 */
import { describe, expect, it } from "vitest";
import { signHeaderAuth } from "../src/index.js";
import { InMemoryObjectStorage, S3ObjectStorageClient, defineObjectStorageContract } from "../src/index.js";
import { createS3CompatibleServer } from "./s3-compatible-server.js";

const BUCKET = "roamlink-test-bucket";
const ENDPOINT = "https://account123.r2.cloudflarestorage.com";
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s3-secret-key-test" };
const BOUNDS = { maxObjectBytes: 65_536 } as const;

function makeServer() {
  let nowMs = Date.parse("2026-01-15T10:00:00.000Z");
  const server = createS3CompatibleServer({
    bucket: BUCKET,
    region: "auto",
    service: "s3",
    ...CREDENTIALS,
    nowMs: () => nowMs,
  });
  return { server, advance: (ms: number) => void (nowMs += ms) };
}

function makeClient(server: ReturnType<typeof makeServer>["server"]) {
  let amzCounter = 0;
  return new S3ObjectStorageClient({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    ...CREDENTIALS,
    region: "auto",
    fetchLike: server.fetchLike,
    bounds: BOUNDS,
    // Distinct amz-date per request; deterministic per test run.
    amzDateSource: () => {
      amzCounter += 1;
      return `20260115T1000${String(amzCounter).padStart(2, "0")}Z`;
    },
  });
}

describe("parity harness construction", () => {
  defineObjectStorageContract("in-memory fake", () => ({
    port: new InMemoryObjectStorage({ bounds: BOUNDS }),
    maxObjectBytes: BOUNDS.maxObjectBytes,
  }));

  defineObjectStorageContract("S3 client over SigV4-validating in-memory server", () => ({
    port: makeClient(makeServer().server),
    maxObjectBytes: BOUNDS.maxObjectBytes,
  }));
});

describe("S3 server signature enforcement (RL-098, fail closed)", () => {
  it("rejects unsigned requests", async () => {
    const { server } = makeServer();
    const response = await server.fetchLike(`${ENDPOINT}/${BUCKET}/exports/x.txt`, { method: "GET" });
    expect(response.status).toBe(403);
  });

  it("rejects requests signed with the WRONG secret", async () => {
    const { server } = makeServer();
    const signed = signHeaderAuth({
      method: "GET",
      path: `/${BUCKET}/exports/org-1/2026/01/aaaabbbbccccdddd-file.bin`,
      query: {},
      host: "account123.r2.cloudflarestorage.com",
      body: "",
      amzDate: "20260115T100000Z",
      region: "auto",
      service: "s3",
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: "attacker-secret",
    });
    const response = await server.fetchLike(`${ENDPOINT}/${BUCKET}/exports/org-1/2026/01/aaaabbbbccccdddd-file.bin`, {
      method: "GET",
      headers: {
        host: "account123.r2.cloudflarestorage.com",
        "x-amz-content-sha256": signed.payloadHash,
        "x-amz-date": signed.amzDate,
        authorization: signed.authorizationHeader,
      },
    });
    expect(response.status).toBe(403);
  });

  it("serves PRESIGNED GETs and expires them deterministically", async () => {
    const { server, advance } = makeServer();
    const client = makeClient(server);
    await client.put({ key: "exports/org-1/2026/01/aabbccdd11223344-report.pdf", body: "presigned content" });
    const url = await client.presign({
      key: "exports/org-1/2026/01/aabbccdd11223344-report.pdf",
      operation: "get",
      expiresInMs: 60_000,
    });
    const before = await server.fetchLike(url.toString(), { method: "GET" });
    expect(before.status).toBe(200);
    expect(await before.text()).toBe("presigned content");
    advance(120_000);
    const after = await server.fetchLike(url.toString(), { method: "GET" });
    expect(after.status).toBe(403);
  });
});
