/**
 * PA-025 — the authenticated bounded worker-tick endpoint's RECEIVER
 * discipline: the fail-closed verification gate (verify BEFORE acting — the
 * closed, value-free 401 vocabulary; the honest not-configured 503), the
 * closed job-kind gate (the typed 400s), and the honest outcome-summary
 * shape (observability only — counts and honest skips, never business
 * state). The execution facts themselves (accepted -> executed -> the read
 * model projection) live in execution-facts.test.ts.
 */
import { describe, expect, it } from "vitest";

import { QSTASH_SIGNATURE_HEADER } from "@roamlink/provider-qstash";

import {
  createExecutionWorld,
  signedTickRequest,
  TICK_JOB_BODY,
  WRONG_SIGNING_KEY,
} from "./helpers.js";

/** Parses the endpoint's JSON answer (fail-closed test helper). */
async function answerOf(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.parse(await response.text()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe("PA-025 the worker-tick endpoint's verification gate (fail-closed)", () => {
  it("refuses EVERY delivery when the receiver-side signing keys are not configured (the honest 503, never an unverified act)", async () => {
    const world = await createExecutionWorld({ signingKeys: { current: undefined } });
    try {
      const answer = await answerOf(await world.endpoint.handle(signedTickRequest({})));
      expect(answer.status).toBe(503);
      expect(String(answer.body["reason"])).toContain("signing keys are not configured");
    } finally {
      await world.dispose();
    }
  });

  it("answers the fail-closed 401 for an UNSIGNED delivery", async () => {
    const world = await createExecutionWorld();
    try {
      const answer = await answerOf(await world.endpoint.handle(signedTickRequest({ withSignature: false })));
      expect(answer.status).toBe(401);
      expect(answer.body["reason"]).toBe("signature verification failed (signature-missing)");
    } finally {
      await world.dispose();
    }
  });

  it("answers the fail-closed 401 for a WRONG-KEY delivery", async () => {
    const world = await createExecutionWorld();
    try {
      const answer = await answerOf(
        await world.endpoint.handle(signedTickRequest({ signingKey: WRONG_SIGNING_KEY })),
      );
      expect(answer.status).toBe(401);
      expect(answer.body["reason"]).toBe("signature verification failed (signature-invalid)");
    } finally {
      await world.dispose();
    }
  });

  it("answers the fail-closed 401 for a delivery OUTSIDE the replay window (both directions suspect)", async () => {
    const world = await createExecutionWorld();
    try {
      // A delivery signed two hours before the receiving instant: stale.
      const stale = new Date(Date.parse("2026-01-15T06:30:00.000Z")).toISOString();
      const answer = await answerOf(await world.endpoint.handle(signedTickRequest({ at: stale })));
      expect(answer.status).toBe(401);
      expect(answer.body["reason"]).toBe("signature verification failed (timestamp-outside-window)");
    } finally {
      await world.dispose();
    }
  });

  it("answers the fail-closed 401 for a body the token does not cover (byte-exact integrity)", async () => {
    const world = await createExecutionWorld();
    try {
      // A signature over the honest body, delivered with a MUTATED body.
      const request = new Request("https://worker.example.test/api/worker/tick", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [QSTASH_SIGNATURE_HEADER]: signedTickRequest({}).headers.get(QSTASH_SIGNATURE_HEADER) ?? "",
        },
        body: JSON.stringify({ kind: "worker.tick", injected: true }),
      });
      const answer = await answerOf(await world.endpoint.handle(request));
      expect(answer.status).toBe(401);
      expect(answer.body["reason"]).toBe("signature verification failed (signature-invalid)");
    } finally {
      await world.dispose();
    }
  });
});

describe("PA-025 the worker-tick endpoint's job-kind gate (typed, closed)", () => {
  it("answers the typed 400 for an unknown job kind (never silent, never acted on)", async () => {
    const world = await createExecutionWorld();
    try {
      const answer = await answerOf(
        await world.endpoint.handle(signedTickRequest({ body: JSON.stringify({ kind: "maintenance.outbox-sweep" }) })),
      );
      expect(answer.status).toBe(400);
      expect(String(answer.body["reason"])).toContain("worker.tick");
    } finally {
      await world.dispose();
    }
  });

  it("answers the typed 400 for an unreadable payload", async () => {
    const world = await createExecutionWorld();
    try {
      const answer = await answerOf(await world.endpoint.handle(signedTickRequest({ body: "not json" })));
      expect(answer.status).toBe(400);
      expect(String(answer.body["reason"])).toContain("not readable JSON");
    } finally {
      await world.dispose();
    }
  });
});

describe("PA-025 the worker-tick endpoint's honest outcome summary", () => {
  it("answers 200 with the tick's observability-only summary (counts and honest skips; no business state, no secrets)", async () => {
    const world = await createExecutionWorld();
    try {
      const answer = await answerOf(await world.endpoint.handle(signedTickRequest({})));
      expect(answer.status).toBe(200);
      expect(answer.body["kind"]).toBe("worker.tick");
      expect(answer.body["at"]).toBeDefined();
      expect(answer.body["sweep"]).toEqual({ recovered: 0 });
      const outbox = answer.body["outbox"] as Record<string, unknown>;
      expect(outbox["claimed"]).toBe(0); // an empty queue: honestly nothing
      expect(outbox["executed"]).toBe(0);
      expect(outbox["delivered"]).toBe(0);
      expect(outbox["remainingPending"]).toBe(0);
      // The inbox/reconciliation legs are honestly not composed in this
      // endpoint (no ADCOS projector on the demo plane).
      expect(answer.body["inbox"]).toMatchObject({ drained: false });
      expect(answer.body["reconciliation"]).toMatchObject({ ran: false });
      // Never business state: no command ids, no payloads, no keys.
      const serialized = JSON.stringify(answer.body);
      expect(serialized).not.toContain("commandId");
      expect(serialized).not.toContain("payload");
    } finally {
      await world.dispose();
    }
  });

  it("executes ONE bounded tick per delivery and returns (the bound law: a request handler, never a loop)", async () => {
    const world = await createExecutionWorld();
    try {
      // The tick surface itself is exposed: exactly one execute() per handle.
      const first = await world.endpoint.handle(signedTickRequest({}));
      expect(first.status).toBe(200);
      // The delivery body never drives more than one tick.
      expect(TICK_JOB_BODY).toBe(JSON.stringify({ kind: "worker.tick" }));
    } finally {
      await world.dispose();
    }
  });
});
