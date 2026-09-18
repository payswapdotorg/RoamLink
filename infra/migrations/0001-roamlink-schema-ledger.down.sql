-- RL-092 / 0001 (down): drop the applied-migrations ledger.
-- The ledger row for 0001 is removed in the same transaction by the runner.
DROP TABLE roamlink_schema_migrations;
