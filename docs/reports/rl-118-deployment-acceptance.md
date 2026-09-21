# RL-118 — Deployment Acceptance Record (the twelve-item "definition of deployed")

**Work item:** RL-118 — production deployment acceptance (tech-lead-handoff §19)
**Accepted head:** `2abdb2e685046e46ca4f667335e3a09b77a40a88` (main; PR #31 merged)
**Gate:** `infra/deployment/demo-acceptance` (RL-117), live mode
**Verdict (2026-09-21 07:19 UTC):** `12 rows — 8 green, 4 named-skip, 0 needs-deployment,
0 red` — **exit 0, the demo deployment is accepted** (named-skips carry their
operator-phase flips, AR-010).

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
