/**
 * QStash transport health-check tests (RL-100): the read-only probe port,
 * the observability-compatible check, the fake's deterministic break/repair
 * control and the hosted client's wire parity - all with ZERO network.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import {
  createQStashHealthCheck,
  InMemoryJobDeliveryQueue,
  QStashProviderError,
  UpstashQStashClient,
  type TransportProbePort,
} from "../src/index.js";

const START = "2026-01-15T10:00:00.000Z";
const TOKEN = "qstash-test-token-ascii_01";

import { createQStashPublishProtocol } from "./qstash-publish-protocol.js";

describe("createQStashHealthCheck (RL-100)", () => {
  it("reports healthy when the read-only probe resolves (deterministic checkedAt)", async () => {
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    const check = createQStashHealthCheck({ probe: queue, clock });
    const result = await check.run();
    expect(result).toMatchObject({ name: "qstash", state: "healthy", checkedAt: START });
  });

  it("reports down with a SUPPRESSED detail when the probe rejects", async () => {
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    queue.breakProbes("endpoint unreachable https://secret-endpoint.example.internal");
    const check = createQStashHealthCheck({ probe: queue, clock });
    const result = await check.run();
    expect(result.state).toBe("down");
    expect(result.detail).toBeDefined();
    // RL-LOCK-016: the rejection reason never reaches the health detail.
    expect(result.detail).not.toContain("secret-endpoint");
    expect(result.detail).not.toContain("endpoint unreachable");
  });

  it("repairs back to healthy (the probe is live, never a boot verdict)", async () => {
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    const check = createQStashHealthCheck({ probe: queue, clock });
    queue.breakProbes();
    expect((await check.run()).state).toBe("down");
    queue.repairProbes();
    expect((await check.run()).state).toBe("healthy");
  });

  it("creates no jobs while probing (read-only: enqueue state is untouched)", async () => {
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    const check = createQStashHealthCheck({ probe: queue, clock });
    await check.run();
    await check.run();
    expect(queue.deadLetters()).toHaveLength(0);
  });

  it("rejects invalid names and non-port probes", () => {
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    expect(() => createQStashHealthCheck({ probe: queue, clock, name: "QSTASH" })).toThrow(/lowercase/);
    expect(() =>
      createQStashHealthCheck({ probe: { probe: "nope" } as unknown as TransportProbePort }),
    ).toThrow(/TransportProbePort/);
  });

  it("composes with the observability HealthRegistry", async () => {
    const { HealthRegistry, runHealthChecks } = await import("@roamlink/observability");
    const clock = new DeterministicClock(START);
    const queue = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    const registry = new HealthRegistry();
    registry.register(createQStashHealthCheck({ probe: queue, clock }));
    const report = await runHealthChecks(registry, { now: () => clock.now() });
    expect(report.state).toBe("healthy");
  });
});

describe("UpstashQStashClient probe wire parity (RL-100)", () => {
  it("probes GET {base}/v2/events with the bearer credential (read-only)", async () => {
    const protocol = createQStashPublishProtocol({ token: TOKEN });
    const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
    await expect(client.probe()).resolves.toBeUndefined();
    expect(protocol.probes).toHaveLength(1);
    expect(protocol.probes[0]?.method).toBe("GET");
    // LIVE-CONFIRMED probe route (PA-017 2026-09-24 evidence): the events
    // route answers 200 on the live service (the old
    // /v2/messages?count=1 pin answers 405).
    expect(protocol.probes[0]?.url).toBe("https://qstash.upstash.io/v2/events");
    expect(protocol.publishes).toHaveLength(0); // no message created
  });

  it("maps non-2xx to provider-error (suppressed provider text)", async () => {
    const protocol = createQStashPublishProtocol({ token: TOKEN, rejectNext: { count: 1, status: 401 } });
    const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
    const error = await client.probe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QStashProviderError);
    expect((error as QStashProviderError).phase).toBe("provider-error");
    expect((error as QStashProviderError).status).toBe(401);
  });

  it("maps network failure to request-not-sent", async () => {
    const protocol = createQStashPublishProtocol({ token: TOKEN, failNext: { count: 1 } });
    const client = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
    const error = await client.probe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QStashProviderError);
    expect((error as QStashProviderError).phase).toBe("request-not-sent");
  });

  it("both implementations satisfy the TransportProbePort (ADR-0003 parity)", () => {
    const clock = new DeterministicClock(START);
    const fake: TransportProbePort = new InMemoryJobDeliveryQueue({ clock, signingKey: "k" });
    const protocol = createQStashPublishProtocol({ token: TOKEN });
    const hosted: TransportProbePort = new UpstashQStashClient({ token: TOKEN, fetchLike: protocol.fetchLike });
    expect(typeof fake.probe).toBe("function");
    expect(typeof hosted.probe).toBe("function");
  });
});
