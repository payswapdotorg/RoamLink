/**
 * @roamlink/persistence - persistence/queue primitives (RL-003).
 *
 * Ports and deterministic in-memory adapters for:
 *  - the transaction boundary (`UnitOfWork`: atomic multi-repository
 *    commit/rollback; transactional outbox by construction);
 *  - durable outbox/inbox primitives (idempotent enqueue, delivery state
 *    machine with retry/backoff, dedupe-keyed admission log);
 *  - optimistic concurrency (version tokens, compare-and-swap, typed
 *    conflict errors - never silent overwrites);
 *  - the versioned migration runner contract + applied-versions ledger
 *    port (+ in-memory fakes).
 *
 * This package depends ONLY on `@roamlink/contracts` and contains NO domain
 * logic, NO business authority and NO vendor/ORM driver. PostgreSQL-
 * compatible drivers implement the same ports in later work items
 * (spec/repository-layout.md "Runtime baseline").
 */
export * from "./unit-of-work.js";
export * from "./outbox.js";
export * from "./inbox.js";
export * from "./optimistic-concurrency.js";
export * from "./migrations.js";
export * from "./in-memory.js";
