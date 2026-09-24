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

### 7.1 Real-run verification record (PA-012, 2026-09-24)

The R2-gated backup/export battery ran for real against the
operator-provided pair: the **PRIMARY** Neon PostgreSQL (the §6.1
database — fully migrated `0001`–`0004`, holding PA-011's recovery
rows; the battery performs NO DDL on it) as the export SOURCE, the
**SCRATCH** database named by `ROAMLINK_BACKUP_SCRATCH_DATABASE_URL`
(migrated AND wiped by the battery, per the disposable contract) as the
restore target, and the operator-provided R2 bucket as the
content-addressed object store. Both legs of
`tests/deployment/test/backup-restore-real.test.ts` (RL-111) ran with
the gates satisfied — **2/2 passed, 0 skipped** (leg A 12.2s, leg B
27.5s over the WAN; a same-state re-run passed 2/2 again in 31.5s,
proving the battery re-runnable against a dirty source + scratch).

B-series laws proven on the real pair (the same laws as the
deterministic reference, `test/backup-restore.test.ts`):

- **Leg A (export → content-addressed R2 upload):** the export through
  the PUBLIC reader contracts is JSON-serializable end to end; every
  exported outbox payload digests exactly to its recorded
  `payload_digest` (sha-256); the exported audit chain VERIFIES and
  detects tampering; the canonical digest is stable across the JSON
  round-trip; the snapshot + manifest land in the bucket under
  CONTENT-ADDRESSED keys (manifest shape: one `data-plane-snapshot`
  object naming the snapshot's full sha-256 digest + sizeBytes — the
  key carries the sha-256 prefix, per-run digests re-derivable by
  re-running; counts = exported repositories/outbox/inbox); the
  single-part PUT ETag equals the MD5 of the stored bytes (the live S3
  wire law — see the real-wire fixes below); reads back from the real
  bucket are byte-identical; the LIST names the object; the bucket is
  tidied (delete).
- **Leg B (scratch restore → the B-series laws):** the snapshot put/get
  through real R2 is byte-identical; the SCRATCH is migrated with the
  REAL infra/migrations and wiped before the restore; records restore
  at their recorded versions (optimistic-concurrency tokens continue);
  ADMITTED inbox dedupe keys are re-admitted; UNSETTLED outbox
  obligations are re-enqueued while terminal records NEVER are (the
  restored terminal key reads null, the unsettled reads PENDING);
  restored records are digest-identical to the source (id, version,
  canonical digest); a replayed admission is DUPLICATE (dedupe keys
  survive); CAS at the recorded version succeeds and advances (the
  restored state is writable); the audit chain still VERIFIES after
  the real round-trip (source → reader contracts → JSON → R2 →
  restore).

Real-wire fixes this run surfaced and landed (all inside the owned
surface, `packages/provider-r2` + the battery; every corrected law pins
the LIVE wire truth, none weakened): the single-part ETag is the MD5
content digest (not sha-256 — content addressing stays the key's job);
the ListObjectsV2 envelope carries the S3 `xmlns` declaration and
32-hex MD5 ETags (the strict parser was corrected to the real shapes);
compressible GETs may arrive gzip-encoded with a WEAK `W/"<md5>"`
validator (the client now requests the identity representation and
normalizes the weak prefix); S3 DELETE is idempotent-success for absent
keys (the port's boolean semantics were corrected to "confirmed
absent"); and the battery itself is now re-entrant/re-runnable
(idempotent seeding, tag-scoped outbox fixture keys, tag-scoped audit
export, scratch wipe before restore — the pool-draining hang the
first real run surfaced is documented in the battery header). The
adapter's own env-gated real-wire legs ran in the same phase
(`packages/provider-r2` env-health: 39/39, 0 skipped — signing,
bucket addressing, the md5 ETag law, list parsing, health
composition).

Post-run state (labels and counts only — zero credential values,
RL-LOCK-016): PRIMARY unchanged in schema (ledger `0001`–`0004`,
digest-current), holding the battery's accumulated fixtures
(read-only census: `ops-backup-verification=6` records,
`ops-backup-verification-audit=9`, outbox 8 rows, inbox 8 rows —
alongside PA-011's recovery rows); SCRATCH migrated (`0001`–`0004`)
and holding the last run's restored state (6 marker records, 3 audit,
3 PENDING unsettled obligations, 2 admissions) — disposable by
contract. The R2 bucket was tidied (the battery deletes its objects);
zero credential values, zero skips, zero failures.

## 8. Known limits / honest gaps (AR-009)

- This runbook was authored WITHOUT a real Neon account in the build
  sandbox: console menu names, branch limits, and default role names are
  described from the provider's published documentation and MUST be
  confirmed at execution time (RL-100+). Record any drift as a runbook
  correction, not a code change.
- Pool defaults are guidance; production sizing is measured, not assumed
  (deployment.md §9 commercial transition).
