-- RL-092 / 0003 (up): the durable outbox (RL-091 data model).
--
-- Transactional outbox storage: business writes and outbox enqueues commit in
-- one database transaction (the adapter's UnitOfWork), delivery workers claim
-- due rows with FOR UPDATE SKIP LOCKED so concurrent workers claim disjoint
-- sets - never the same record twice (no double delivery).
--
-- State machine (closed vocabulary, shared with @roamlink/persistence):
--   PENDING -> DELIVERING -> DELIVERED | PENDING (retry) | FAILED (terminal)
-- `next_attempt_at` is NULL exactly when the record is terminal
-- (DELIVERED/FAILED); the claim index only ever touches PENDING rows.

CREATE TABLE roamlink_outbox (
  idempotency_key TEXT PRIMARY KEY,
  payload_bytes BYTEA NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('PENDING', 'DELIVERING', 'DELIVERED', 'FAILED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error_reason TEXT,
  retry_max_attempts INTEGER NOT NULL CHECK (retry_max_attempts >= 1),
  retry_backoff_ms JSONB NOT NULL
);

-- The claimDue scan: due PENDING rows in deterministic order.
CREATE INDEX roamlink_outbox_claim_due
  ON roamlink_outbox (next_attempt_at, created_at, idempotency_key)
  WHERE delivery_state = 'PENDING';

-- Ordered listing by state (read models / operations).
CREATE INDEX roamlink_outbox_by_state
  ON roamlink_outbox (delivery_state, created_at, idempotency_key);
