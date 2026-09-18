/**
 * @roamlink/provider-redis - the bounded ephemeral-coordination adapter
 * surface (RL-096).
 *
 * Layer: platform provider adapter (leaf). spec/deployment.md §2/§8 +
 * ADR-0003: Upstash Redis is a BOUNDED EPHEMERAL ACCELERATOR (rate
 * limiting, hot cache, short-TTL coordination, abuse protection) and is
 * NEVER the durable source of truth for any business state. The port
 * shape enforces that by construction (every write carries a TTL; values
 * are size-bounded; there are no durable structures).
 *
 * Surfaces:
 *  - {@link EphemeralCoordinationPort}: the replaceable port;
 *  - {@link InMemoryEphemeralCoordination}: the deterministic fake
 *    (tests/local; explicit clock, capacity bounds);
 *  - {@link UpstashRedisRestClient}: the hosted REST adapter
 *    (UPSTASH_REDIS_REST_URL/TOKEN via `tryParseUpstashRedisEnv`);
 *  - {@link defineEphemeralCoordinationContract}: the reusable contract
 *    battery proving port-parity (ADR-0003 migration rule) - both shipped
 *    implementations AND future replacements run it;
 *  - {@link DistributedFixedWindowLimiter}: the distributed admission
 *    primitive mirroring @roamlink/resilience's LimiterDecision shape;
 *  - {@link createRedisHealthCheck}: observability composition (an
 *    accelerator being down must never by itself fail readiness).
 *
 * The system stays CORRECT without Redis: consumers degrade to their
 * non-accelerated path on failure (deployment.md §7).
 */
export * from "./port.js";
export * from "./engine.js";
export * from "./fake.js";
export * from "./upstash-rest.js";
export * from "./env.js";
export * from "./health.js";
export * from "./fixed-window-limiter.js";
export * from "./port-contract.js";
