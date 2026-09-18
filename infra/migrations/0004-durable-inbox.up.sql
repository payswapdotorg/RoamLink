-- RL-092 / 0004 (up): the durable webhook inbox (RL-091 data model).
--
-- Append-only admission log for webhook ingress (RL-LOCK-009: a webhook is
-- durably admitted and verified; arrival is never treated as proof of
-- physical delivery - processing stays in the workers).
--
-- Exactly ONE admitted record per dedupe key is enforced by the DATABASE
-- itself: a PARTIAL UNIQUE INDEX on the ADMITTED rows. Later arrivals for
-- the same key are admitted as DUPLICATE audit rows; rejected arrivals
-- (REJECTED) never occupy the key.
--
-- `sequence` is a real IDENTITY column: monotonic in commit order, with
-- possible gaps when a transaction rolls back (a rolled-back admission burns
-- its sequence value). Consumers get deterministic ordering, not 1-based
-- contiguity.

CREATE TABLE roamlink_inbox (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL,
  admission_state TEXT NOT NULL
    CHECK (admission_state IN ('ADMITTED', 'DUPLICATE', 'REJECTED'))
);

-- The admission invariant: exactly one ADMITTED row per dedupe key.
CREATE UNIQUE INDEX roamlink_inbox_one_admission_per_key
  ON roamlink_inbox (dedupe_key)
  WHERE admission_state = 'ADMITTED';

CREATE INDEX roamlink_inbox_by_state
  ON roamlink_inbox (admission_state, sequence);
