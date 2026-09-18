-- RL-092 / 0001 (up): the applied-migrations ledger itself.
--
-- The migration runner records (version, applied_at, script_digest) inside
-- the SAME transaction that applies each migration, so a migration and its
-- bookkeeping commit atomically or not at all. `script_digest` is the
-- SHA-256 of the applied .up.sql file content: a later manifest run can
-- therefore detect "the file changed after it was applied" (drift) instead
-- of silently guessing.
--
-- This is the first migration: the ledger row for 0001 is written into the
-- table this file creates, in one transaction.

CREATE TABLE roamlink_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL,
  script_digest TEXT CHECK (script_digest IS NULL OR script_digest ~ '^[0-9a-f]{64}$')
);
