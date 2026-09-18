/**
 * The transport translation seam (RL-089): Web Request/Response <-> app-kit
 * HttpRequest/HttpResponse, translation ONLY.
 */
import { describe, expect, it } from "vitest";

import {
  MethodNotAllowedError,
  errorResponse,
  internalErrorResponse,
  translateRequest,
  translateResponse,
} from "../src/index.js";
import { HTTP_STATUS, type HttpResponse } from "@roamlink/app-kit";

describe("translateRequest", () => {
  it("carries method, path+query and lowercased headers for GET", async () => {
    const request = new Request("https://host.example/v1/connectivity?fresh=1", {
      headers: { "X-RoamLink-Tenant-Id": "org:x", Authorization: "Bearer t" },
    });
    const translated = await translateRequest(request);
    expect(translated.method).toBe("GET");
    expect(translated.path).toBe("/v1/connectivity?fresh=1");
    expect(translated.headers["x-roamlink-tenant-id"]).toBe("org:x");
    expect(translated.headers["authorization"]).toBe("Bearer t");
    expect(translated.body).toBeUndefined();
  });

  it("carries the POST body BYTE-EXACT (webhook signatures verify the delivered bytes)", async () => {
    const payload = '{"event_id":"evt-1","occurred_at":"2026-01-15T08:30:00.000Z"}';
    const request = new Request("https://host.example/v1/webhooks/adcos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const translated = await translateRequest(request);
    expect(translated.method).toBe("POST");
    expect(translated.body).toBe(payload);
  });

  it("rejects verbs outside the app-kit contract (GET reads, POST commands)", async () => {
    await expect(
      translateRequest(new Request("https://host.example/v1/devices", { method: "DELETE" })),
    ).rejects.toThrow(MethodNotAllowedError);
    await expect(
      translateRequest(new Request("https://host.example/v1/devices", { method: "PUT" })),
    ).rejects.toThrow(MethodNotAllowedError);
  });
});

describe("translateResponse", () => {
  it("carries status, body and extra headers with a JSON content-type default", async () => {
    const response: HttpResponse = {
      status: 202,
      body: '{"outcome":"ADMITTED"}',
      headers: { "x-roamlink-test": "1" },
    };
    const translated = translateResponse(response);
    expect(translated.status).toBe(202);
    expect(translated.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(translated.headers.get("x-roamlink-test")).toBe("1");
    expect(await translated.text()).toBe('{"outcome":"ADMITTED"}');
  });

  it("serves an empty body honestly when the app-kit response carries none", async () => {
    const translated = translateResponse({ status: 204 });
    expect(await translated.text()).toBe("");
  });
});

describe("errorResponse", () => {
  it("emits the app-kit ApiErrorResource shape with details suppressed", async () => {
    const response = errorResponse(503, "HOST_NOT_READY", "not ready");
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["kind"]).toBe("unavailable");
    expect(body["reason"]).toBe("HOST_NOT_READY");
    expect(body["message"]).toBe("not ready");
    expect(body["retryable"]).toBe(false);
  });

  it("the host's internal-error mapping matches the contract's suppressed shape", async () => {
    const response = internalErrorResponse();
    expect(response.status).toBe(HTTP_STATUS.internalError);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["reason"]).toBe("INTERNAL_ERROR");
    expect(body["message"]).toBe("the request failed (details suppressed)");
  });
});
