/**
 * Port-parity contract tests (RL-096): the SAME battery runs against
 *  1. the in-memory fake, and
 *  2. the Upstash REST client over an in-memory REST protocol stand-in
 *     (no network),
 * proving the two paths are behaviorally identical (ADR-0003: provider
 * replacements must preserve the same contract tests).
 */
import { describe } from "vitest";
import { DeterministicClock } from "@roamlink/testkit";
import { InMemoryEphemeralCoordination, UpstashRedisRestClient } from "../src/index.js";
import { defineEphemeralCoordinationContract } from "../src/index.js";
import { createUpstashRestProtocol } from "./upstash-rest-protocol.js";

const START = "2026-01-15T10:00:00.000Z";
const TOKEN = "test-bearer-token-ascii-ONLY_01";

describe("parity harness construction", () => {
  defineEphemeralCoordinationContract("in-memory fake", () => {
    const clock = new DeterministicClock(START);
    return {
      port: new InMemoryEphemeralCoordination({ clock }),
      advance: (ms: number) => void clock.advanceBy(ms),
    };
  });

  defineEphemeralCoordinationContract("Upstash REST client over in-memory REST protocol", () => {
    const clock = new DeterministicClock(START);
    const protocol = createUpstashRestProtocol({ clock, token: TOKEN });
    const client = new UpstashRedisRestClient({
      baseUrl: "https://example-redis.upstash.io",
      token: TOKEN,
      fetchLike: protocol.fetchLike,
    });
    return {
      port: client,
      advance: (ms: number) => void clock.advanceBy(ms),
    };
  });
});
