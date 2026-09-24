# Neon PostgreSQL provisioning runbook (RL-095)

Operator script for provisioning the **durable source of truth** on a real
Neon account. This runbook is the RL-095 deliverable; executing it is the
RL-100+ real-account verification phase. Every step is written so a fresh
operator can follow it without conversation history.

**Authority reminder (spec/deployment.md, ADR-0003):** Neon PostgreSQL is
the durable relational authority for RoamLink-owned state. Redis, QStash,
R2 and Vercel are never sources of truth. RoamLink reaches Neon only
through PostgreSQL ports (`@roamlink/persistence`); Neon is an adapter, not
architecture.

## 0. Prerequisites

- A Neon account (free plan is the documented early target).
- `psql` (or any PostgreSQL client) for smoke checks.
- Access to the environment-secret store for the target environment
  (Vercel project settings or the operator's secret manager).
- This repository checked out.

## 1. Create the project and environments

1. Create a Neon project named `roamlink-<environment>` — one project per
   environment (see `../environments/` for the separation rules):
   - `roamlink-development` — local/dev;
   - `roamlink-preview` — Vercel preview deployments;
   - `roamlink-demo` — public demo;
   - `roamlink-production` — production.
2. Where practical use **Neon branches** inside each project for
   preview/ephemeral work (deployment.md §6: "Neon should provide isolated
   branches where practical"). Never share a database across environments.
3. **Never** grant preview environments production credentials
   (deployment.md §6).

## 2. Collect connection strings

For each environment:

1. In the Neon console, copy the **pooled connection string** (host
   contains the `-pooler` label) — this is the default `DATABASE_URL` for
   request/serverless paths.
2. Also copy the **direct (unpooled) connection string** — reserve it for
   migrations and long-running workers.
3. Keep the default `?sslmode=require` (or upgrade to `verify-full` in
   production). RoamLink's parser
   (`@roamlink/provider-neon` `parseNeonConnectionString`) **rejects**
   `sslmode=disable`/`allow`/`prefer` and strings without an explicit TLS
   mode.

Record which value is pooled vs direct in the environment secret sheet
(labels only — the secret itself goes into the secret store, never into a
file, ticket, or chat).

## 3. Configure DATABASE_URL (secret handling)

1. Put the pooled string into the environment's `DATABASE_URL` secret
   (Vercel project → Settings → Environment Variables, or the secret
   manager). Template: `../providers/neon.env.example`.
2. Never commit the value: templates in this directory carry empty values
   only, and the pre-push scan rejects token-shaped strings.
3. Validate the value WITHOUT printing it, e.g. with the parser surface:

   ```sh
   DATABASE_URL="$DATABASE_URL" node --input-type=module -e '
     const m = await import("@roamlink/provider-neon");
     const r = m.tryParseNeonEnv(process.env);
     if (r.ok) {
       console.log("DATABASE_URL OK:", r.config.pooledEndpoint ? "pooled" : "direct", r.config.sslMode);
     } else {
       console.error("DATABASE_URL INVALID (value not shown)");
       process.exit(1);
     }'
   ```

   The checker prints only the classification — pooled/direct + sslmode —
   never the string.

## 4. Serverless safety settings

Free-tier/conservative-compute guidance (deployment.md §5) — operational
defaults, not correctness logic:

- Use the **pooled** endpoint for serverless request paths (Vercel
  functions) to survive Neon scale-to-zero and connection churn.
- Keep `maxConnections` LOW (RoamLink default guidance: 5; see
  `@roamlink/provider-neon` `NEON_POOL_DEFAULTS`). Neon computes are small;
  a larger number does not buy correctness, only exhaustion.
- Connect timeout ~10s; expect cold starts after scale-to-zero. Health
  checks must tolerate a slow first probe without marking the deployment
  failed (the host composes `createNeonHealthCheck` for this).
- Compute autosuspending to zero is EXPECTED behavior; alerting on
  "database asleep" is noise. Alert on probe failures instead.

## 5. Migrations (ordering with RL-090)

Real SQL migrations land under `infra/migrations` (RL-090). Until that
work item merges, there is intentionally NO migration step here — record
"migrations pending RL-090" in the deployment log rather than inventing a
schema. When RL-090 lands:

1. Run migrations against the **direct** connection string.
2. Verify `migration-recovery` expectations from `tests/deployment`
   (clean application from empty state, idempotent re-runs).
3. Record the applied migration ledger hash in the deployment log.

## 6. Health verification (deployment.md §7)

1. Register `createNeonHealthCheck({ probe })` in the host's health route;
   the probe runs a `SELECT 1`-class query through the REAL driver.
2. Verify: `GET /api/health` reports `healthy` for `database`, and a
   deliberately wrong password yields `down` with a SUPPRESSED detail
   (no connection-string content in the response — RL-LOCK-016).
3. Verify failure semantics once per environment; do not ship a health
   endpoint that has never failed.

### 6.1 Real-run verification record (PA-011, 2026-09-23)

The DATABASE_URL-gated persistence batteries ran for real against the
operator-provided Neon PostgreSQL (the **PRIMARY** durable target, over
its direct endpoint; the **SCRATCH** database named by
`ROAMLINK_BACKUP_SCRATCH_DATABASE_URL` stays reserved for the RL-111
backup battery and was not exercised in this run). PRIMARY was verified
read-only BEFORE any battery ran: it was empty and never migrated (no
ledger, no public tables), so the batteries' documented
down-to-empty/up-from-empty cycles destroyed no operator data — §5's
ordering (migrations over the direct endpoint, clean application from
empty state, idempotent re-runs) was executed exactly. Outcomes, one line
per battery (labels and counts only — zero credential values,
RL-LOCK-016):

- `packages/persistence-postgres/test/concurrency-real.test.ts` (RL-106):
  **7/7 passed, 0 skipped** — the two-connection invariants (READ
  COMMITTED isolation boundary, `FOR UPDATE SKIP LOCKED` disjoint
  claiming, SAVEPOINT-fenced enqueue races, the delivered-outcome vs
  `recoverInFlight` exactly-once race, stranded-claim re-ownership)
  proven on the real pool.
- `packages/persistence-postgres/test/rollback-roundtrip.test.ts`
  (RL-112): **3/3 passed, 0 skipped** — RT-4 up → representative data →
  down-to-base → up on the real pool, the ledger consistent end to end.
- `tests/deployment/test/recovery-battery.test.ts` (RL-110): **8/8
  passed, 0 skipped** — the DATABASE_URL-gated real leg ran: the
  authenticated cron kick recovered the stranded claims and advanced the
  inbox backlog beyond one bounded batch against real SQL.

Zero real-wire fixes were required: every adapter assumption held on the
live wire (the only observation is the documented node-postgres warning
that `sslmode=require` is treated as `verify-full` — a stricter default,
not a failure). PRIMARY's post-run state: fully migrated
(`0001`–`0004` applied, digest-current) holding the recovery battery's
seeded rows.

## 7. Backup/export path (deployment.md §2 requirement)

- Minimum viable: scheduled logical export (Neon console or
  `pg_dump` via the direct endpoint) stored in the R2 bucket configured
  for backups (see `cloudflare-r2.env.example`), application-level
  encryption per spec/security.md.
- Verify a restore into a scratch branch before calling an environment
  ready; the deployment checks in `../runbooks/deployment-runbook.md` §8
  gate on it.

## 8. Known limits / honest gaps (AR-009)

- This runbook was authored WITHOUT a real Neon account in the build
  sandbox: console menu names, branch limits, and default role names are
  described from the provider's published documentation and MUST be
  confirmed at execution time (RL-100+). Record any drift as a runbook
  correction, not a code change.
- Pool defaults are guidance; production sizing is measured, not assumed
  (deployment.md §9 commercial transition).
