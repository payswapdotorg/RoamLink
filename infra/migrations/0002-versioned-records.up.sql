-- RL-092 / 0002 (up): the versioned record store (RL-091 data model).
--
-- Every domain aggregate that persists through the @roamlink/persistence
-- RecordRepository port lives here, partitioned by `repository` (the port's
-- repository name, validated by parseRepositoryName: ^[a-z][a-z0-9-]{0,63}$ -
-- the CHECK mirrors the port's validation as defense in depth, it does not
-- replace it). Known repository partitions today include the identity/org,
-- device, intent, commerce, notifications, webhook-inbox, reconciliation and
-- retention aggregates; the partition name is data, so new domains land here
-- additively without a schema change.
--
-- Optimistic concurrency (RL-LOCK-014): `version` is the record revision;
-- every mutation is a conditional statement (CAS on (repository, record_id,
-- version)) - never a blind overwrite.

CREATE TABLE roamlink_records (
  repository TEXT NOT NULL CHECK (repository ~ '^[a-z][a-z0-9-]{0,63}$'),
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, record_id)
);

CREATE INDEX roamlink_records_by_repository
  ON roamlink_records (repository, version);
