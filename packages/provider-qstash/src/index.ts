/**
 * @roamlink/provider-qstash - the durable-jobs delivery adapter surface
 * (RL-097).
 *
 * Layer: platform provider adapter (leaf). spec/deployment.md §2/§8 +
 * ADR-0003: QStash is RETRYABLE ASYNC DELIVERY - never business-state
 * authority. The port is transport-only by construction: jobs are
 * durably recorded in the caller's PostgreSQL-backed ledger (idempotency
 * key = the durable job id, RL-LOCK-014) and only the DELIVERY crosses
 * this boundary.
 *
 * Job flow (deployment.md §4): webhook admission / scheduled work ->
 * durable queue (Postgres) -> QStash delivery -> receiver endpoint
 * verification. Receivers MUST verify the signature header (webhook-inbox
 * rigor: constant-time compare, replay window both directions, closed
 * failure codes, value-free errors) BEFORE acting.
 *
 * Surfaces:
 *  - {@link DurableJobDeliveryPort}: the replaceable delivery port;
 *  - {@link InMemoryJobDeliveryQueue}: the deterministic fake simulating
 *    the full delivery loop (push, retry/backoff, DLQ, redrive) with
 *    SIGNED deliveries so receiver verification is tested for real;
 *  - {@link UpstashQStashClient}: the hosted transport (pinned publish
 *    API, dedupe header, injected fetchLike);
 *  - {@link QStashSignatureVerifier} + `signQStashDelivery` /
 *    `renderQStashSignatureHeader`: receiver-side verification with
 *    current/next signing-key rotation;
 *  - {@link TransportProbePort}: the read-only reachability probe (RL-100;
 *    enqueue mutates provider state and can never serve as a probe) with
 *    the deterministic fake control (breakProbes/repairProbes) and the
 *    hosted client's read-only REST GET;
 *  - {@link createQStashHealthCheck}: the observability-compatible health
 *    check over the probe (hosts register it as an OPTIONAL dependency -
 *    a down transport degrades, never blocks, readiness);
 *  - {@link tryParseQStashEnv}: fail-closed, secret-redacting env access;
 *  - {@link defineDurableJobDeliveryContract}: the reusable transport
 *    battery (ADR-0003 replacement rule).
 */
export * from "./port.js";
export * from "./verifier.js";
export * from "./fake.js";
export * from "./upstash-qstash.js";
export * from "./env.js";
export * from "./health.js";
export * from "./port-contract.js";
