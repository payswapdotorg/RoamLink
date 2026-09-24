# RL-118 — Deployment Acceptance Record (the twelve-item "definition of deployed")

**Work item:** RL-118 — production deployment acceptance (tech-lead-handoff §19)
**Accepted head:** `2abdb2e685046e46ca4f667335e3a09b77a40a88` (main; PR #31 merged)
**Gate:** `infra/deployment/demo-acceptance` (RL-117), live mode
**Verdict (2026-09-21 07:19 UTC):** `12 rows — 8 green, 4 named-skip, 0 needs-deployment,
0 red` — **exit 0, the demo deployment is accepted** (named-skips carry their
operator-phase flips, AR-010).

**Re-run (2026-09-24, PA-015):** the twelve-row record was regenerated at the
campaign's final head `10ba5d9a231d3b3042ca6693e8730cfa50d98869` against the
live demo surface, folding in the PA-011/PA-012/PA-013 real-run records that
landed since — see §7 for the re-run verdict (the verdict above is the
original 2026-09-21 run's and is preserved as history).

---

## 1. The twelve-row verdict (spec/deployment.md §7, verbatim rows)

| # | §7 check | Verdict | Decisive evidence |
|---|---|---|---|
| 1 | real database migration passes from empty state | named-skip | `migration-recovery.test.ts` 6/6 green; the §5 run on the demo database is recorded in §3 below (the R2-gated `backup-restore-real` leg that flips this row green is the operator-phase flip) |
| 2 | backup/restore passes | named-skip | `backup-restore.test.ts` 4/4 green; the RL-111 real legs need the R2 env surface (not enabled on the operator's Cloudflare account — error 10042, a Dashboard action) |
| 3 | health/readiness is real, not fake | **green** | live `/readyz` + `/v1/readiness` `degraded:rate-limit` (database + migrations healthy) at HTTP 200 — servable, rollback rule accepted; `health-readiness.test.ts` 4/4 + `rollback-decision-rule.test.ts` 2/2 + rollback runner selftest 6/6 |
| 4 | webhook signatures are configured | **green** | `ROAMLINK_WEBHOOK_SIGNING_KEYS` configured + well-formed (key id `demo-1`); live ingress rejected the unsigned smoke delivery with HTTP 401 (fail-closed); `runtime-hardening.test.ts` 8/8 + smoke runner selftest |
| 5 | ADCOS compatibility gate runs against the configured endpoint | named-skip | the ADCOS env is absent — the RL-108 probe honestly reports not-configured (exit 2); flips when the operator issues the RoamLink application credential in ADCOS production (out-of-band) |
| 6 | no in-memory adapter is used for production | **green** | `DATABASE_URL` is `postgres://` (the composition refuses fakes and `pglite://` in production); live `/v1/readiness` composes `database:healthy, migrations:healthy` |
| 7 | stuck outbox recovery is implemented | **green** | `recovery-battery.test.ts` 8/8 + `cold-start-shutdown.test.ts` 7/7 (recoverInFlight sweep, AR-007) |
| 8 | inbox backlog processing advances beyond one batch | **green** | `recovery-battery.test.ts` 8/8 (bounded-drain batch progression, AR-008) |
| 9 | R2 uploads use scoped credentials | named-skip | the R2 surface is unset in an otherwise-carried demo env (object storage is optional for hosts without artifact surfaces); R2 is not enabled on the operator's Cloudflare account |
| 10 | Redis is optional for correctness | **green** | no Redis env configured — the non-accelerated path IS the configured reality; `dependency-failure.test.ts` 5/5; the live readiness surfaces the rate-limit degradation honestly and stays servable |
| 11 | job retry is idempotent | **green** | `recovery-battery.test.ts` 8/8 + `cold-start-shutdown.test.ts` 7/7 (deterministic per-day job ids; idempotency-keyed obligations, RL-LOCK-014) |
| 12 | synthetic smoke journey is green | **green** | the §6b smoke ran against the live surface: **7/7 checks** (healthz alive; readyz + api readiness honest vocabulary; home 303→/login with markers; admin mounted; webhook ingress fail-closed) |

## 2. The deployment (provider resources — names/IDs only, no secret values)

- **Vercel** (Hobby): project `roamlink` (`prj_ZnOFB8LA8351963PFF37cZ4VHUVS`),
  team `team_4KOoA5CgtYaOF85yFXPeMXLt`, root directory `apps/portal-host`,
  framework Next.js, build command `next build --webpack`, git-connected to
  `payswapdotorg/RoamLink` (production branch `main`). Production alias:
  **https://roamlink-ten.vercel.app**. Accepted deployment
  `dpl_BxZREn8a1odsoituewVUqsxUmY8e` @ `2abdb2e` (the merge of PR #31).
  The first deployment attempt (`dpl_FVbiW5xViw3DTHGb1tfJ2qurjMcX` @
  `0845470`) failed — see §4.
- **Neon PostgreSQL** (free): org `org-shy-shadow-21570034`, project
  `roamlink-demo` / `little-moon-25640560`, region `aws-us-east-1`, pg16,
  default branch `br-wild-cake-avetaedg` (`main`), compute endpoint
  `ep-green-glitter-avtbw3i7.c-11.us-east-1.aws.neon.tech` (+ its `-pooler`
  alias for the runtime DSN). Databases: `neondb` (the demo source of truth)
  and `restore_scratch` (the RL-111 restore-leg scratch database — never the
  source).
- **Composio**: vercel connection `ca_31iruA2qEdfl` (API key, ACTIVE) and
  neon connection `ca_Ktgm5irkMl1T` (API key, ACTIVE), created from the
  operator-supplied keys against the existing `offisos-*` API-key auth
  configs (`ac_tog5dUNk3fK5`, `ac_u49Yo1jl027B`). The github toolkit is
  OAuth2-only — wiring it is an operator dashboard action.
- **Cloudflare R2**: not enabled on the operator's account (error 10042;
  enabling is a Dashboard action) — rows 2/9 carry the honest named-skip.
- **Upstash (Redis/QStash)**: not configured for the demo environment —
  Redis is optional for correctness (§7 row 10 green on the non-accelerated
  path); the readiness surface reports `degraded:rate-limit` honestly and
  stays servable.

### The demo env surface configured on the deployment (names only)

`DATABASE_URL` (Neon pooled), `NEON_DIRECT_URL` (Neon direct),
`ROAMLINK_WEBHOOK_SIGNING_KEYS` (registry, key id `demo-1`),
`ROAMLINK_WEBHOOK_ENVIRONMENT=production`, `CRON_SECRET`.
Unset (honest degradations): Upstash Redis/QStash, R2, ADCOS, SLO
objectives, outbox/maintenance destinations. No secret value is recorded
here (RL-LOCK-016); the values live only in the Vercel project's encrypted
environment store.

### PA-015 deployment-inventory update (2026-09-24)

The live production deployment serving **https://roamlink-ten.vercel.app**
was queried through the surface itself (2026-09-24 ~03:31 UTC):
`/healthz` answers `alive` (HTTP 200); `/readyz` and `/v1/readiness`
answer `degraded:rate-limit` at HTTP 200 — `database:healthy`,
`migrations:healthy` ("4 migration(s) applied"), `rate-limit:degraded`
(no Redis accelerator configured; the non-accelerated path is the
configured reality) — the honest vocabulary, servable per the rollback
rule; the §6b smoke is 7/7 against it (§7.4).

**Deployment lag (recorded verbatim from the orchestrator's dispatch
note):** the live production deployment was at `63b7446` (the merge of
PR #45 — the last auto-deploy). The merges of PR #46 (`cd38f7a`) and
PR #47 (`10ba5d9`) did NOT auto-deploy: the Vercel account's daily
deployment quota was exhausted (reset ~05:14 UTC 2026-09-24). The
main-vs-live delta (`cd38f7a..10ba5d9`) is provider-internal fixes +
test batteries + runbook evidence — **zero demo-surface behavior
change**: `git diff --stat cd38f7a..10ba5d9 -- apps/` is EMPTY (verified
in this run; it is also empty across the full live-to-head range
`63b7446..10ba5d9 -- apps/` — the portal app's own source is unchanged
across the entire lag), and the demo env configures neither R2 nor
Redis, so the `packages/provider-r2` / `packages/provider-redis` source
changes in that range cannot affect the deployed demo's behavior. The
accepted head of record for the PA-015 re-run is
`10ba5d9a231d3b3042ca6693e8730cfa50d98869` (the cloned campaign head);
the live surface's head is recorded here as the deployment-lag note.
Both are honest fields.

Dated corrections to the inventory above (the original lines stay
as-was):

- **Cloudflare R2** is now ENABLED on the operator's account, with a
  scoped token (Object Read & Write scoped to the single bucket — the
  runbook §2.4 discipline): the PA-012 real run exercised the full live
  round-trip through it (`neon-provisioning.md` §7.1). The original
  "error 10042 / not enabled" line above is historical.
- **Upstash (Redis/QStash)**: the demo env still carries no Redis keys
  BY CONFIGURATION (the non-accelerated path is the configured reality —
  row 10's law). PA-013 (2026-09-24) separately verified the Redis
  transport legs against the operator's account
  (`deployment-runbook.md` §7). The QStash surface is still not
  delivered — AR-009's standing wire note remains open (append-only).
- The demo env surface additionally carries `ROAMLINK_DEMO_ACCOUNTS=1`
  (the public demo-roster gate — a non-secret flag; the personas are
  public fixtures by design) alongside the keys listed above. No secret
  value is recorded here (RL-LOCK-016).

## 3. The §5 migration run (row 1's operator-phase record)

`pnpm --filter @roamlink/persistence-postgres db:migrate` against the demo
database from empty state (2026-09-21 06:52 UTC): **4/4 applied**,
then `db:manifest` verified every recorded script digest against the
on-tree file digest — **drift `current` on all four**:

| Version | Description | SHA-256 (recorded == script) |
|---|---|---|
| 0001 | roamlink schema ledger | `6f395e75590cbe1c3796f6dc390f00a4a8ac78c329bf383cad96057a242ec927` |
| 0002 | versioned records | `00baa02311c9ae9b89a34fdb9a683e4e7abce6dbae7b765374860032ff0b1f68` |
| 0003 | durable outbox | `7c5bb901ecbad0c56e78925ae0537b6a8e0a512f7d61e5ea23b339756c77a71d` |
| 0004 | durable inbox | `b184cb6514d588c140b7fff1d2dec5284f3464abb5fb532822f7d9717f3e56b1` |

## 4. The pre-deploy build fix (PR #31 — the first-ever Next bundle of the host)

The hosted runtime had never been bundled by Next (the release gates
typecheck and test the composition, but no gate runs `next build`). The
first deployment attempt failed on both of Next 16's bundlers: they refuse
the workspace's TypeScript-ESM import convention (`./module.js` naming the
sibling `module.ts`). PR #31 (`dda6b04`, CI green x2, merged as `2abdb2e`):

- `apps/portal-host/next.config.ts` — webpack `extensionAlias`
  `{".js": [".ts",".tsx",".js"]}` (builds run with `next build --webpack`)
  and the build's internal TS pass skipped (the typecheck authority stays
  `pnpm typecheck`; the internal pass would npm-install `@types/react`
  inside the pnpm workspace);
- `apps/portal-host/package.json` — `react`/`react-dom@19.3.0` declared
  (Next's peer requirements) + `@types/react(-dom)` dev deps.

Verified before merge: `next build --webpack` exit 0 (11 routes); `next
start` against the real Neon demo database; the §6b smoke 7/7 locally.

## 5. The gate invocation (runbook §8.1, live mode)

```bash
BASE_URL=https://roamlink-ten.vercel.app \
DATABASE_URL=<neon pooled> \
NEON_DIRECT_URL=<neon direct> \
ROAMLINK_BACKUP_SCRATCH_DATABASE_URL=<neon restore_scratch> \
ROAMLINK_WEBHOOK_SIGNING_KEYS=<registry> \
ROAMLINK_WEBHOOK_ENVIRONMENT=production \
CRON_SECRET=<secret> \
NODE_ENV=production \
pnpm demo:acceptance
```

(values elided, RL-LOCK-016; the report prints names/shapes only).
Full verbatim output preserved in the campaign record.

## 6. Open operator flips (all AR-010 named-skips)

1. **ADCOS application credential** (row 5): issue the RoamLink client
   id + secret + webhook secret in ADCOS production (out-of-band), set the
   four `ADCOS_*` keys, re-run — the RL-108 probe then runs against
   https://adcos.vercel.app (verified live and healthy; the pinned v2.0
   contract matches its real surface).
2. **R2** (rows 1/2/9): enable R2 on the Cloudflare account (Dashboard
   action), provision a scoped token (Object Read & Write on the single
   bucket), set the four `R2_*` keys — the RL-111 export/upload/restore
   legs then run inside the gate and flip the rows green.
3. **Redis/QStash** (optional): supply the Upstash REST pair to compose the
   distributed rate limiter (removes the `degraded:rate-limit` readiness
   entry) and the QStash surface for the event-driven maintenance path.

## 7. PA-015 re-run verdict (2026-09-24)

The final deployment-acceptance re-run: the same twelve §7 checks, the
same gate (`infra/deployment/demo-acceptance`, RL-117, live mode),
executed against the campaign's final head and the LIVE demo surface,
with the real-infrastructure evidence that landed since the original
record folded in (the original froze at `2abdb2e` / PR #31 — sixteen PRs
stale: #32–#47, verified by the merge log).

- **Head of record:** `10ba5d9a231d3b3042ca6693e8730cfa50d98869` (main;
  the merge of PR #47). Baseline gate at this head: `pnpm check` green —
  lint, typecheck, architecture:check and the full workspace test leg
  (45 packages, 0 fail) all exit 0.
- **Live surface:** https://roamlink-ten.vercel.app — the live
  deployment is at `63b7446` (PR #45); the deployment-lag note in §2
  records that the main-vs-live delta is proven demo-surface-neutral.
- **Gate invocation:** live mode (`BASE_URL` exported; the demo env keys
  riding the invocation shell — validated by name/shape only, values
  never echoed, RL-LOCK-016). Checker exit **0**; standalone
  `pnpm smoke` exit **0**.
- **Invocation discipline (this WO's highest law):** the live demo
  database is the demo's source of truth and was NEVER touched by a
  battery. The real leg that would run against `DATABASE_URL` (the
  RL-110 recovery leg — it seeds and mutates) was left env-absent in the
  gate invocation, so the batteries ran their deterministic cores with
  named skips; every mutation-flip rests on the merged PA-011/PA-012/
  PA-013 real-run records plus this run's READ-ONLY ledger check (§7.3).
  The `DATABASE_URL` / `NEON_DIRECT_URL` credentials were used for
  exactly the two permitted things: config-surface shape validation
  (§7.4) and read-only SELECTs against the migration ledger (§7.3).

### 7.1 The twelve-row verdict (re-run)

| # | §7 check | Verdict | Decisive evidence |
|---|---|---|---|
| 1 | real database migration passes from empty state | **green** | on-tree: `migration-recovery.test.ts` 6/6 green (this run's checker line). Operator-phase flip **landed (PA-011, 2026-09-23)**: `rollback-roundtrip.test.ts` RT-4 **3/3, 0 skipped** (up → representative data → down-to-base → up on the real pool, the ledger consistent end to end) and the `recovery-battery.test.ts` real leg **8/8, 0 skipped** — `neon-provisioning.md` §6.1, `deployment-runbook.md` §5. This run's own read-only ledger check of the LIVE demo database (SELECT only, session forced read-only server-side): `roamlink_schema_migrations` present with `0001`–`0004`, EVERY `script_digest` equal to the on-tree `.up.sql` sha-256 (**digest-current on all four**), the version set matching on-tree exactly, `applied_at` 2026-09-21T06:52:07–10Z (the §3 run's window). The checker's invocation-level named-skip line for this row is preserved in §7.2. |
| 2 | backup/restore passes | **green** | on-tree: `backup-restore.test.ts` 4/4 green (the deterministic B-series reference, this run's checker line). Operator-phase flip **landed (PA-012, 2026-09-24)**: `backup-restore-real.test.ts` **2/2 passed, 0 skipped** against the operator's R2 + PostgreSQL pair (PRIMARY as the no-DDL export source; SCRATCH migrated AND wiped as the restore target); a same-state re-run passed 2/2 again (the battery re-runnable); the B-series laws proven on the real wire (digest-identical restore, surviving dedupe keys with DUPLICATE replay, continuing versions via CAS, terminal-outbox records never re-enqueued, the audit chain verifying post-round-trip) — `neon-provisioning.md` §7.1, `deployment-runbook.md` §8. |
| 3 | health/readiness is real, not fake | **green** | live `/readyz` + `/v1/readiness` `degraded:rate-limit` (database:healthy, migrations:healthy, rate-limit:degraded) at HTTP 200 — servable, rollback rule accepted; `health-readiness.test.ts` 4/4 + `rollback-decision-rule.test.ts` 2/2 + rollback runner selftest 6/6 (the checker's own evidence this run). |
| 4 | webhook signatures are configured | **green** | `ROAMLINK_WEBHOOK_SIGNING_KEYS` configured + well-formed (key id `demo-1`) — the live demo registry exported into the invocation satisfies the checker's shape law (the value never echoed, RL-LOCK-016); live ingress rejected the unsigned smoke delivery with HTTP 401 (fail-closed); `runtime-hardening.test.ts` 9 passed, 2 named-skipped (the Redis/QStash-gated real legs, AR-010) + the smoke runner selftest. |
| 5 | ADCOS compatibility gate runs against the configured endpoint | named-skip | the ADCOS env is absent — the RL-108 probe honestly reports not-configured (exit 2); flips when the operator issues the RoamLink application credential in ADCOS production (out-of-band) — the original row's reason, unchanged and still open. |
| 6 | no in-memory adapter is used for production | **green** | live confirmation: `/v1/readiness` composes the database + migrations checks (database:healthy, migrations:healthy) — the deployed host runs the real PostgreSQL path (the checker's line this run); plus this run's isolated config-surface validation (§7.4): the live `DATABASE_URL` (pooled) and `NEON_DIRECT_URL` (direct) are postgresql:// DSNs with explicit `sslmode=require` — the row-6 protocol law passes (the composition refuses fakes and `pglite://` in production) and the exported surface validates with zero issues. |
| 7 | stuck outbox recovery is implemented | **green** | `recovery-battery.test.ts` 7 passed, 1 named-skip (the real leg — flipped real-green by PA-011: 8/8, 0 skipped against real SQL) + `cold-start-shutdown.test.ts` 7/7; the recoverInFlight sweep (RL-093/AR-007) — the checker's evidence this run. |
| 8 | inbox backlog processing advances beyond one batch | **green** | the bounded-drain batch progression (RL-094/AR-008) proven through the cron route in `recovery-battery.test.ts` (this run's deterministic core: 7 passed, 1 named-skip) — and the real leg ran green in PA-011 (8/8, 0 skipped) against real SQL. |
| 9 | R2 uploads use scoped credentials | **green** | the R2 surface is configured and verified: the scoped S3 key pair (Object Read & Write scoped to the single bucket — the runbook §2.4 discipline) with the full live round-trip recorded by PA-012 (content-addressed upload, byte-identical read-back, the md5 ETag wire law; `neon-provisioning.md` §7.1) and the adapter's env-gated real-wire legs **39/39, 0 skipped** in the same phase. The checker's config validation passes on this run's exported env (zero issues — §7.4); the R2 keys themselves are operator-held and were deliberately NOT carried by this invocation (the checker's invocation-level named-skip line is preserved in §7.2). |
| 10 | Redis is optional for correctness | **green** | no Redis env is configured — the non-accelerated path IS the configured reality; `dependency-failure.test.ts` 5/5; the live readiness surfaces the rate-limit degradation honestly and stays servable (the checker's evidence this run). PA-013 (2026-09-24) separately proved the Redis transport legs against the operator's account (`packages/provider-redis` 43/43, 0 skipped; the limiter-under-load real leg admitted exactly maxCost of 50 concurrent takes) — the demo env remains non-accelerated BY CONFIGURATION, so this row's configured reality is unchanged. |
| 11 | job retry is idempotent | **green** | `recovery-battery.test.ts` + `cold-start-shutdown.test.ts` green (this run); deterministic per-day job ids (retries are duplicates) and idempotency-keyed obligations with digest-verified replays (RL-LOCK-014). |
| 12 | synthetic smoke journey is green | **green** | the §6b smoke ran against the live surface: **7/7 checks** — healthz alive; readyz + api readiness honest vocabulary (`degraded:rate-limit`, servable); home 303→/login with markers; admin mounted; webhook ingress fail-closed (HTTP 401); standalone `pnpm smoke` exit 0. |

**Re-run verdict (record level): 12 rows — 11 green, 1 named-skip, 0
needs-deployment, 0 red — the demo deployment is accepted** (row 5 keeps
its honest named-skip; its operator flip remains open).

### 7.2 The checker's invocation-level output (preserved verbatim)

The gate's own aggregate for THIS invocation (exit 0):

> verdict: 12 rows — 8 green, 4 named-skip, 0 needs-deployment, 0 red |
> the demo deployment is accepted (named-skips carry their operator-phase
> flips, AR-010)

The four invocation-level named-skips, with the checker's own evidence
lines (each row's flip is recorded in §7.1's table):

- **Row 1** — "the real empty-state migration on the demo database is an
  operator-phase leg (runbook §5): no demo DATABASE_URL is carried by
  this invocation (AR-010 named-skip; the operator-phase flip records
  the §5 run)". PA-015's discipline kept `DATABASE_URL` out of the
  battery env — running the RL-110 real leg would WRITE to the live demo
  database, which this work order forbids; the flip rests on PA-011 plus
  the §7.3 read-only ledger check.
- **Row 2** — "the RL-111 real legs are env-gated and did not fully run
  in this invocation: missing a PostgreSQL DATABASE_URL (the source);
  the full R2 env surface (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY, R2_BUCKET); a DISTINCT
  ROAMLINK_BACKUP_SCRATCH_DATABASE_URL (never the source) (AR-010
  named-skip; the operator-phase flip runs them against the real
  deployment surfaces)". The flip landed as PA-012.
- **Row 5** — "the ADCOS env is absent — the probe honestly reports
  not-configured (exit 2, its own semantics; AR-010 named-skip: the
  operator-phase flip runs it against the configured demo ADCOS
  endpoint)". Still open; no ADCOS credentials exist.
- **Row 9** — "the R2 surface is unset in an otherwise-carried demo env
  (object storage is optional for hosts without artifact surfaces) —
  configure it and re-run for the §7 acceptance (AR-010 named-skip)".
  The R2 keys are operator-held (PA-012 exercised them against the real
  bucket); this invocation deliberately did not carry them.

No row is narrated greener than the checker's own semantics resolve it:
rows 1/2/9 are named-skip AT THE INVOCATION LEVEL (preserved above,
verbatim) and green at the record level ONLY because their
operator-phase flips — the mechanism the checker's own vocabulary
defines for exactly these rows ("named-skips carry their operator-phase
flips, AR-010") — have landed as merged, dated records (PA-011/PA-012),
cited per row in §7.1. Row 5's flip has NOT landed and stays named-skip.

### 7.3 The read-only ledger check (row 1's live evidence)

One SELECT-only session against the live demo database (the session was
forced read-only server-side; zero writes, zero DDL, zero batteries):

- `roamlink_schema_migrations` (the applied-migrations ledger): 4 rows —
  versions `0001`–`0004`, `applied_at` 2026-09-21T06:52:07.164Z …
  2026-09-21T06:52:10.287Z (the §3 migration run's window).
- Every row's `script_digest` equals the sha-256 of the on-tree
  `infra/migrations/<version>-*.up.sql` — **digest-current on all four**
  (the digests match §3's recorded table: `6f395e75…`, `00baa023…`,
  `7c5bb901…`, `b184cb65…`).
- The ledger's version set matches the on-tree migration set exactly
  (no drift, no missing, no extra).
- Table-presence census (catalog SELECT only): `roamlink_schema_migrations`,
  `roamlink_records`, `roamlink_outbox`, `roamlink_inbox` — all present.

(The session observed the same node-postgres sslmode warning PA-011
recorded in §6.1 — `sslmode=require` treated as verify-full, a stricter
default, not a failure.)

### 7.4 The config-surface shape validation + live-surface evidence

- **Config validation (the checker's own law, values never echoed):**
  `validateDemoConfig` over the exported live demo surface — **ok, zero
  issues**; `database` configured (postgresql:// — pooled runtime DSN +
  direct migration DSN, both with explicit `sslmode=require`),
  `webhook` configured and well-formed (key id `demo-1`),
  `adcos`/`redis`/`r2`/`qstash-receiver` not configured (the honest
  unset surfaces — the R2 keys are operator-held, not carried here). The
  row-6 protocol law passes on the live DSNs.
- **Live surface (queried through itself):** `/healthz` `alive` HTTP 200;
  `/readyz` and `/v1/readiness` `degraded:rate-limit` HTTP 200 with
  `database:healthy`, `migrations:healthy` ("4 migration(s) applied"),
  `rate-limit:degraded` — the honest vocabulary, servable; home `/`
  303 → `/login` (the login document renders with its markers, including
  the public demo-roster quick logins enabled by
  `ROAMLINK_DEMO_ACCOUNTS=1`); `/admin` mounted behind the auth gate;
  the unsigned webhook delivery rejected HTTP 401 (fail-closed).
- **§6b smoke: 7/7** (healthz; readyz vocabulary; api readiness
  vocabulary; home-surface; admin-surface; static-assets;
  webhook-ingress fail-closed) — standalone `pnpm smoke` exit 0.

### 7.5 What remains open after this re-run

1. **Row 5 (ADCOS)**: the operator must issue the RoamLink application
   credential in ADCOS production and set the four `ADCOS_*` keys (the
   original §6 item 1, unchanged).
2. **QStash (AR-009's standing wire note — append-only, never flipped or
   reworded here)**: the QStash surface (token + current/next signing
   keys) is still not delivered; the built env-gated legs
   (`packages/provider-qstash` client-wire; the escalation-path leg of
   `runtime-hardening.test.ts`) skip with named reasons. The live
   signature-canonicalization record executes when the operator delivers
   the keys.
3. **The deployment lag itself**: the main head (`10ba5d9`) is not yet
   deployed to production (the Vercel quota note in §2); the delta is
   proven demo-surface-neutral, and the quota reset (~05:14 UTC
   2026-09-24) unblocks the next deployment — re-running the §6b smoke
   and this gate against the redeployed surface is the natural
   follow-up.
