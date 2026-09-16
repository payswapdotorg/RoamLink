/**
 * @roamlink/audit - append-only audit/security event stream (RL-051).
 *
 * Layer: platform/security (spec/security.md "Audit"). Every
 * security-relevant action is recorded as an immutable, UTC-instanced,
 * digest-chained {@link AuditEvent} with actor/tenant/command correlation:
 *
 *  - closed event taxonomy: auth, secret-access, authority-decision,
 *    admin-override; closed outcome vocabulary: allowed, denied, degraded,
 *    failed;
 *  - tamper-evident SHA-256 digest chaining over canonical JSON (per-log
 *    monotonic sequence + prevDigest linkage); verification recomputes every
 *    digest and breaks at the first tampered event;
 *  - APPEND-ONLY by construction: the {@link AuditLog} port exposes no
 *    update/delete/truncate; records are deeply frozen; retention (RL-054)
 *    must archive copies, never rewrite the chain;
 *  - queryable by correlation ID (plus actor, tenant, category, time range);
 *  - structural adapters for @roamlink/secrets access notifications and
 *    @roamlink/edge capability-gate decisions (no package dependency -
 *    TypeScript structural typing keeps the graph contracts-only).
 *
 * Depends ONLY on @roamlink/contracts. Durable sinks are additive adapters
 * behind the same port. KNOWN LIMIT: a hash chain without an external
 * anchor detects any tamper that does not rewrite the entire subsequent
 * tail; periodic digest publication (checkpointing) is future work.
 */
export * from "./audit-event.js";
export * from "./audit-log.js";
export * from "./adapters.js";
