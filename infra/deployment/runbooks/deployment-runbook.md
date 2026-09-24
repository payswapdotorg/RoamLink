# RoamLink deployment runbook (RL-099)

The step-by-step operator script: provision providers, set environment
variables, deploy, verify health — ending in the deployment.md §7 checks.
Executing against real accounts is the RL-100+ phase; this runbook is the
script. Read `../free-tier-constraints.md` first, then provider-specific
runbooks (`neon-provisioning.md`; Upstash/R2 provisioning steps are §2
here).

**Authority framing (RL-LOCK discipline):** after this runbook, the only
durable source of truth is Neon PostgreSQL; Redis/QStash/R2/Vercel are
adapters. Nothing in this runbook grants authority to a provider.

## 1. Prerequisites

- [ ] Operator access: Neon, Upstash, Cloudflare, Vercel accounts.
- [ ] This repository checked out; the deploying host app identified
      (Wave-6 integration gate decides the host composition; the host
      adopts `../vercel.json` as its project configuration).
- [ ] A private secret sheet (labels only — values go DIRECTLY into the
      target environment's secret store and are never written into files
      or chat).
- [ ] `pnpm check` and both release gates green at the commit being
      deployed (`pnpm mvp-gate`, `pnpm production-gate`).

## 2. Provision providers (per environment)

Work environment by environment: `development`, `preview`, `demo`,
`production` (deployment.md §6 — NEVER share provider resources across
environments; NEVER put production ADCOS credentials in preview).

### 2.1 Neon (durable PostgreSQL) — REQUIRED

Follow `neon-provisioning.md` in full. Summary:

1. One project per environment; isolated branches for preview work.
2. Collect pooled + direct connection strings; keep explicit TLS
   `sslmode` (RoamLink rejects plaintext modes).
3. Enter `DATABASE_URL` (+ `NEON_DIRECT_URL`) into the environment's
   secret store.
4. Validate with the parser (classification only, never echo).

### 2.2 Upstash Redis (bounded accelerator) — OPTIONAL

1. Create a REST database per environment (Upstash console).
2. Enter `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` into the
   environment's secret store (template:
   `../providers/upstash-redis.env.example`).
3. Omit both keys to run the non-accelerated path — that is a supported,
   correct configuration (Redis is optional for correctness).
4. Remember the bounded-accelerator rule: no durable business state, ever.

Real-account provision note (PA-013, 2026-09-24): the operator delivered
and VERIFIED the Upstash Redis REST credentials for this phase (URL +
token, exported into the run shell ONLY — never written into any file,
per §3's discipline). The accelerator's env-gated real-wire legs then ran
against that account (`packages/provider-redis` env-health: the pinned
REST envelope end to end, the fixed-window limiter's real TTL behavior,
health composition) together with the runtime-hardening
limiter-under-load leg — outcomes in §7's real-run record. Every key
the batteries touch is run-scoped and carries a mandatory TTL: the
bounded-accelerator law held on the live service.

### 2.3 Upstash QStash (retryable async delivery) — OPTIONAL

1. In the Upstash console create/copy the QStash credentials for the
   environment.
2. Enter `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
   `QSTASH_NEXT_SIGNING_KEY` (keep both signing keys configured so
   rotation never drops deliveries), optional `QSTASH_URL` (template:
   `../providers/upstash-qstash.env.example`).
3. Configure the RECEIVER-side signing-key expectation in the deploying
   host (receivers verify every delivery BEFORE acting — RL-097).
4. Register the receiver URLs the host exposes (webhook/projector
   endpoints must be HTTPS and reachable by QStash).

Real-account provision note (PA-013, 2026-09-24): the QStash surface
(`QSTASH_TOKEN` + the current/next signing keys, optional `QSTASH_URL`)
was NOT delivered in this phase (requested in the operator thread; it
may arrive in a later run). The live QStash wire legs are BUILT and
env-gated in `packages/provider-qstash/test/client-wire.test.ts`: the
read-only probe + health composition, the publish round-trip (dedupe
id + bounded delay headers, over an RFC 2606 `.invalid` sink so no
party beyond the operator's own account is ever contacted), and the
signed receiver round-trip that retires AR-009's standing wire note
(the receiver mechanism — an HTTPS capture endpoint under
`QSTASH_LIVE_RECEIVER_URL`, readable via plain GET — is documented in
the battery). They SKIP with their named reasons until the operator
configures the keys; AR-009's wire note stays OPEN.

### 2.4 Cloudflare R2 (large artifacts) — OPTIONAL

1. Create one bucket per environment (e.g. `roamlink-<env>-artifacts`).
2. Create an R2 API token with Object Read & Write SCOPED TO THAT BUCKET
   ONLY (deployment.md §7 "R2 uploads use scoped credentials" — never an
   account-wide token).
3. Enter `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET` (and `R2_ENDPOINT` only if overriding) into the
   environment's secret store (template:
   `../providers/cloudflare-r2.env.example`).
4. Enable lifecycle rules per the artifact classes (attachments/exports/
   backups) when the retention policy lands.

## 3. Configure environment variables (secret handling)

1. For each environment, take `../environments/<env>.env.example` as the
   KEY LIST and enter values ONLY into the environment's secret store
   (Vercel project → Settings → Environment Variables, or the operator
   secret manager).
2. Values are entered once, per environment, per key. The `.env.example`
   files in this repository ALWAYS stay empty; the pre-push secret scan
   rejects token-shaped strings.
3. Rotation notes: QStash signing keys rotate via current/next pair;
   R2 tokens rotate by issuing a new scoped token; Neon credentials
   rotate in the Neon console and update the secret store atomically.

## 4. Deploy

1. From a clean checkout at the reviewed commit:
   `pnpm install && pnpm check && pnpm mvp-gate && pnpm production-gate`
   — all must pass BEFORE deployment.
2. Import the host app into the Vercel project (or use the existing
   project), wire the git branch mapping:
   - `main` → demo (or production when commercialized);
   - pull-request branches → preview (preview env vars only).
3. Apply `../vercel.json` (cron = the daily maintenance trigger only;
   higher-frequency work is event-driven via QStash — see
   `../free-tier-constraints.md`).
4. Deploy. Verify the build uses NO in-memory persistence adapter for the
   environment (deployment.md §7: "no in-memory adapter is used for
   production") — the host must compose the real PostgreSQL driver path
   (RL-090) for any durable environment.

## 5. Migrations (ordering with RL-090)

Until RL-090 lands there is intentionally NO migration step — record
"migrations pending RL-090" in the deployment log rather than inventing a
schema. When RL-090 lands: run migrations against `NEON_DIRECT_URL`,
verify clean application from empty state + idempotent re-runs
(`tests/deployment` migration-recovery expectations), record the ledger
hash.

Real-run evidence (PA-011, 2026-09-23): the ordering above was executed
and recorded against the operator-provided PostgreSQL (the PRIMARY
durable target, over its direct endpoint; verified read-only empty and
never migrated before the run). The RL-112 round-trip battery
(`packages/persistence-postgres/test/rollback-roundtrip.test.ts`) passed
3/3 with the DATABASE_URL-gated RT-4 leg RUN (no skip): migrateUp from
empty → representative data → migrateDown to base → migrateUp, with the
ledger consistent end to end (exactly the migration set, digest-current,
ascending) — clean application from empty state plus the idempotent
re-application, proven on the real engine. The RL-106 concurrency suite
(7/7 passed, 0 skipped) and the RL-110 recovery battery's real leg (8/8
passed, 0 skipped) passed on the same database in the same run, with
zero real-wire fixes. Labels and counts only — zero credential values
(RL-LOCK-016); the full per-battery record lives in
`neon-provisioning.md` §6.1.

## 6. Verify health (real, not fake — deployment.md §7)

The composed readiness surface (RL-100) exposes the per-dependency truth
through the SAME aggregation everywhere:

- `GET /healthz` — liveness: the process answers `{status:"alive"}` (no
  dependency calls — readiness owns those);
- `GET /readyz` — the host's composed readiness (the database probe + the
  migration ledger +, when `ROAMLINK_API_BASE_URL` is configured, a
  bounded-timeout probe of the API's own readiness);
- `GET /v1/readiness` — the API service's composed readiness (RL-100):
  the REAL per-dependency probes bound at composition, aggregated into
  the frozen honest vocabulary
  `ready | degraded:<dependency,...> | not-ready:<reason,...>` (200 for
  ready/degraded — servable; 503 for not-ready). REQUIRED dependencies
  (PostgreSQL, the migration ledger) being down is not-ready; an OPTIONAL
  accelerator/transport (Redis/QStash/R2) being down only ever DEGRADES —
  its absence can never fail readiness for correctness it does not own.

1. The ready/readiness endpoints must report the registered checks:
   `database` (Neon; REQUIRED), `migrations` (the applied-versions ledger;
   REQUIRED), and the composed optional adapters — `redis`, `qstash`,
   `object-storage` — each present ONLY when that adapter is actually
   configured for the environment (an uncomposed dependency is never
   reported — no fake surface).
2. Prove failure semantics once per environment: break a credential
   (temporarily) and confirm the affected check reports `down` with a
   SUPPRESSED detail (no connection string, no token — RL-LOCK-016) and
   the vocabulary surfaces `degraded:<dep>` (optional) or
   `not-ready:<dep>` + HTTP 503 (required).
3. Confirm readiness treats the Redis accelerator being down as
   non-fatal when the host is configured to continue without it.

## 6b. Synthetic smoke journey (RL-100)

The executable §7 gate: deploy -> wait ready -> run smoke -> record.
The suite lives in `../smoke/` (see `../smoke/README.md` for the check
list and the no-lie law) and needs NO secrets and NO customer data:

1. WAIT READY: poll `GET $BASE_URL/readyz` until the answer is the
   honest vocabulary (ready or degraded:*); a `not-ready:*` answer means
   the deployment is NOT ready — fix before continuing (a not-ready
   answer IS still proof the truth layer works; the smoke will pass it
   through its vocabulary check and fail the overall run only where the
   deployment lies — an operator may also record a not-ready state as a
   blocked deploy rather than a smoke failure).
2. RUN SMOKE (the deployed stack; replace the example origins):
   `BASE_URL=https://<host-origin> [API_URL=https://<api-origin>] pnpm smoke`
   — exit 0 required. The suite asserts the honest vocabulary on
   `/readyz` + `/v1/readiness`, the shell surfaces, referenced static
   assets, and the fail-closed webhook ingress; it FAILS if any
   dependency lies (a ready claim over a down check, an out-of-vocabulary
   status, a servability-code mismatch, hidden unhealthy state).
3. RECORD: paste the smoke output (per-check `[ok]`/`[FAIL]` lines + the
   summary) into the deployment log, with the deployed commit SHA; a
   FAILED smoke blocks the §8 gate — fix, redeploy, re-run.
4. First run in a NEW environment: also run `pnpm smoke:selftest` once
   (proves the runner itself; loopback only) and record the version of
   the smoke used with the deployment.

## 7. Verify the provider surfaces (RL-095..098 wiring)

- [ ] Redis: a probe write/read through the accelerator succeeds AND a
      Redis outage leaves the platform correct (the non-accelerated path
      serves requests).
- [ ] QStash: enqueue a test job from the durable ledger; the receiver
      VERIFIES the signature (positive + tampered case), acts on 2xx, and
      a deliberately failing receiver retries with backoff then lands in
      the DLQ (redrive works).
- [ ] R2: put/get/list/delete through the host with the scoped token;
      presigned GET works from a clean client and EXPIRES; keys follow
      the content-addressed convention (`provider-wiring.md`).
- [ ] A stuck-outbox recovery exercise and an inbox backlog progression
      beyond one batch (deployment.md §7 items; the RL-093/RL-094 fixes
      are the implementation authority).

Real-run evidence (PA-013, 2026-09-24): the Redis row above is no
longer operator-pending for the accelerator's transport legs — they ran
for real against the operator-provided Upstash Redis REST account
(credentials exported env-only, per §3). Outcomes, one line per battery
(labels and counts only — zero credential values, RL-LOCK-016):

- `packages/provider-redis` env-health (RL-096, env-gated): **4/4
  passed, 0 skipped** — the pinned REST envelope end to end on the
  live service (PING, byte-exact SET/GET, SET NX, PTTL countdown, real
  expiry at the TTL boundary, DEL idempotence, the pinned EVAL
  increment with its guaranteed TTL), the fixed-window limiter's real
  TTL behavior (epoch-aligned boundary counting; rollover into a fresh
  bucket key carrying its own TTL), health composition over the live
  port, and credential redaction (RL-LOCK-016).
- `packages/provider-redis` full package: **43/43 passed, 0 skipped**
  (39 deterministic + the 4 real-wire legs).
- `tests/deployment/test/runtime-hardening.test.ts` (RL-096/RL-107):
  **10 passed | 1 named skip (11)** — the deterministic cores green AND
  the Redis-gated real leg RAN: the distributed fixed-window limiter
  admitted EXACTLY maxCost (25 of 50 concurrent takes) over the live
  accelerator (atomic increments, real TTLs — the per-window admission
  law proven under concurrent load). The one skip is the QStash-gated
  escalation leg, with its named reason (the QStash env surface is not
  configured — keys pending operator delivery).
- `packages/provider-qstash` client-wire (RL-097, env-gated live legs):
  **9 passed | 3 named skips (12)** — the deterministic wire battery
  green; the live legs (read-only probe + health composition, publish
  round-trip with the dedupe/delay headers, the signed receiver
  round-trip) SKIP with the named reason: the QStash env surface is
  not configured. Canonicalization outcome: NOT YET RECORDED — the
  live signature canonicalization (AR-009's standing wire note)
  executes when the operator delivers the QStash keys; the battery's
  receiver mechanism (`QSTASH_LIVE_RECEIVER_URL`) is documented in the
  test file.

Real-wire fixes this run surfaced and landed (inside the owned surface,
`packages/provider-redis`; every corrected law pins the LIVE wire
truth, none weakened — all existing deterministic legs stayed green):
the pinned EVAL command array was missing the REQUIRED numkeys count —
the real Redis EVAL wire shape is `EVAL script numkeys key [key...] arg
[arg...]`, and the live service answers HTTP 400 to the numkeys-less
form. The client now sends `["EVAL", <pinned script>, "1", <key>,
<amount>, <ttlMs>]`, the shared in-memory engine parses (and fail-closed
validates) the same real shape, and the in-memory fake sends the
byte-identical array — ONE wire shape everywhere.

## 8. Final deployment checks (deployment.md §7 gate)

Before calling the environment ready, ALL of:

- [ ] real database migration passes from empty state (when RL-090 has landed);
- [ ] backup/restore passes (Neon export -> R2 -> scratch restore);
- [ ] health/readiness is real (proven failing, not just green);
- [ ] webhook signatures are configured and verification is enforced;
- [ ] ADCOS compatibility gate runs against the configured endpoint;
- [ ] no in-memory adapter is used for the durable environment;
- [ ] stuck outbox recovery is implemented and exercised;
- [ ] inbox backlog processing advances beyond one batch;
- [ ] R2 uploads use scoped credentials;
- [ ] Redis is optional for correctness (demonstrated);
- [ ] job retry is idempotent (demonstrated via duplicate jobId enqueue);
- [ ] synthetic smoke journey is green (hosted) — §6b executed against the
      deployed origin: `BASE_URL=... pnpm smoke` exit 0, output recorded
      with the deployed commit SHA (a lying dependency blocks this gate).

Real-run evidence (PA-012, 2026-09-24): the backup/restore row above is
no longer operator-pending for the R2 leg — the RL-111 battery
(`tests/deployment/test/backup-restore-real.test.ts`) ran against the
operator-provided pair (PRIMARY Neon PostgreSQL as the export source
over its direct endpoint — NO DDL on it; the SCRATCH database
migrated AND wiped by the battery as the restore target; the R2
bucket as the content-addressed store) and PASSED **2/2 with 0
skips**: export through the public reader contracts →
content-addressed upload (the md5 ETag wire law, byte-identical
read-back, the manifest naming the sha-256 digests) → scratch restore
→ the B-series laws (digest-identical records, surviving dedupe keys
with DUPLICATE replay, continuing versions via CAS, terminal-outbox
records never re-enqueued, the audit chain verifying post-round-trip).
A same-state re-run passed 2/2 again (the battery is re-runnable). The
run surfaced and fixed real-wire assumptions in the R2 adapter within
the owned surface (md5 ETags, the xmlns ListObjectsV2 envelope, weak
validators on compressed GETs, idempotent DELETE semantics) — every
corrected law pins the live wire truth, none weakened. The R2
scoped-credential surface was exercised in the same phase by the
adapter's env-gated real-wire legs (`packages/provider-r2` env-health:
39/39, 0 skipped). Full record: `neon-provisioning.md` §7.1 (labels
and counts only — zero credential values, RL-LOCK-016).

### 8.1 The executable demo-acceptance gate (RL-117)

The §8 checklist is COMPOSED AND DECIDED by one command:
`infra/deployment/demo-acceptance/check.mjs` (root scripts
`pnpm demo:acceptance` / `pnpm demo:acceptance:selftest`). It composes the
PUBLIC verification surfaces of this repository — the tests/deployment
batteries (RL-075..RL-112), the §6b smoke exports, the §9 rollback rule's
servable-readiness law, the RL-108 ADCOS compatibility probe and the
environments config surface — and fills the config-validation gaps the
on-tree pieces do not cover: webhook-signature configuration PRESENCE
(`ROAMLINK_WEBHOOK_SIGNING_KEYS`), the no-in-memory-adapter production law
at the config level, and the R2 scoped-credential surface validation.

The output is a TWELVE-ROW verdict report — the twelve §7 checks, verbatim
and in order. EVERY row resolves to exactly one of:

- `green` — verified on this run, evidence recorded on the row;
- `named-skip` — an env-gated leg that cannot run in this invocation, with
  the NAMED reason (the AR-010 discipline verbatim: explicit reason, CI
  stays green, operator-phase flip);
- `needs-deployment` — the row's decisive leg requires the live demo
  surface (BASE_URL) this invocation lacks;
- `red` — the row failed (the §8 gate is BLOCKED);
- `config-invalid` — the invocation's configuration is invalid.

Exit codes (closed and distinguishable): **0** no red row and the
configuration is valid (named-skips carry their operator-phase flips);
**1** at least one red row (NOT accepted); **2** config-invalid (refused
before any check runs).

How the operator runs it against the demo deployment:

1. **Prove the runner once per environment** (loopback, no deployment):
   `pnpm demo:acceptance:selftest` — exit 0 required. It pins the
   no-fake-success law itself: a sabotaged (lying) deployment flips the
   verdict, a config-invalid invocation is refused with exit 2.
2. **On-tree mode** (from the commit being deployed):
   `pnpm demo:acceptance` — runs every check that needs no live surface:
   the batteries' verdicts, the probe (honest not-configured when the
   ADCOS env is absent), the smoke/rollback runner proofs, and the config
   validation of whatever demo env surface the invocation carries.
3. **Live mode** (the demo acceptance itself):
   `BASE_URL=https://<demo-host-origin> pnpm demo:acceptance` (add
   `API_URL=...` when the API is split; export the demo environment into
   the invocation — env-only, never files — so the config-validation rows
   can verify it). This runs the §6b smoke against the DEPLOYED stack, the
   servable-readiness law on `/readyz` + `/v1/readiness`, and the
   config-level laws — and flips the live rows from needs-deployment to
   green/red.
4. **Env-gated legs** (the AR-010 flips): when the invocation carries the
   demo DATABASE_URL + the R2 surface + a DISTINCT
   `ROAMLINK_BACKUP_SCRATCH_DATABASE_URL`, the RL-111 real legs run INSIDE
   this gate (real export -> R2 -> scratch restore migrated with the real
   infra/migrations); when it carries DATABASE_URL, the RL-110 real-DB leg
   runs. A bogus/unreachable DSN FAILS those rows honestly (fail-closed —
   never a silent pass). Record the named-skips that remain in the
   deployment log with their reasons and the phase that will flip them.
5. **RECORD**: paste the twelve-row report + the exit code + the deployed
   commit SHA into the deployment log. Exit 1 or 2 blocks the §8 gate —
   fix, redeploy, re-run. The gate never touches provider consoles, never
   reads values out of the secret store, and never echoes a credential
   (RL-LOCK-016): configuration is validated BY NAME and SHAPE only.

## 9. Rollback (redeploy-previous-SHA) (RL-112)

When a deployed release is broken, the rollback is a REDEPLOY of the
previous application SHA — never a schema gamble. The migration decision
rule below is EXECUTABLE (`../../deployment/rollback/check.mjs`, run via
`pnpm rollback:check`): health + readiness servability + the §6b synthetic
smoke decide acceptance, not prose judgment.

### 9.1 The redeploy-previous-SHA procedure

1. **Pin the previous SHA.** From the deployment log (§6b step 3: every
   deploy records its commit SHA), identify the last SHA whose smoke run
   was green. Confirm it exists: `git cat-file -e <sha>`. Build provenance
   matters: `pnpm check && pnpm mvp-gate && pnpm production-gate` must be
   green AT THAT SHA (they were, when it shipped — re-run only if the
   release artifact is being rebuilt).
2. **Redeploy** that SHA into the SAME environment (Vercel project
   rollback to the previous deployment, or a redeploy of the pinned SHA).
   The deploying host composes the real PostgreSQL driver path exactly as
   §4 requires — a rollback never introduces an in-memory adapter.
3. **Do NOT touch the schema as part of the redeploy.** Migrations are
   NEVER part of a rollback (see 9.2).
4. **Run the §6 health checks + the §6b synthetic smoke**, then the
   EXECUTABLE decision rule:

   ```bash
   BASE_URL=https://<host-origin> [API_URL=https://<api-origin>] pnpm rollback:check
   ```

   It asserts, in order: `/healthz` liveness; `/readyz` and
   `/v1/readiness` answer the honest vocabulary AND are SERVABLE
   (`ready | degraded:*` at HTTP 200 — a truthful `not-ready:*` answer
   means the rollback did NOT restore service and is REJECTED); and the
   §6b synthetic smoke is green (including the no-lie law). Exit 0 =
   the rollback is accepted; record the output + both SHAs in the
   deployment log. Exit 1 = the rollback is NOT accepted — fix, redeploy,
   re-run. (Prove the runner itself once per environment with
   `pnpm rollback:check:selftest` — loopback only, no deployment needed.)

### 9.2 The migration decision rule: a rollback NEVER auto-runs migrateDown

- **Default — forward-fix:** the deployed schema is ADDITIVE
  (infra/migrations discipline: new migrations only, never edited — the
  ledger records each applied file's SHA-256 and `manifest()` reports
  drift). A previous application SHA therefore runs against the schema the
  newer release applied: redeploy, and the NEWER release's pending
  migrations are applied forward when it ships again. No down-migration
  happens, automatically or otherwise.
- **Deliberate down-migration (the exception, operator-commanded only):**
  when a rollback MUST shed applied migrations (e.g. the forward release's
  schema cannot coexist with the previous application), the down-migration
  is a maintenance-window action run BY THE OPERATOR via
  `pnpm --filter @roamlink/persistence-postgres db:rollback -- <target>`
  (or the equivalent direct runner call), NEVER an automatic step of any
  deploy/rollback tooling. Why so strict: the RL-112 round-trip
  (`packages/persistence-postgres/test/rollback-roundtrip.test.ts`) proves
  on the real engine that the current baseline down migrations DROP the
  data tables (`roamlink_records`, `roamlink_outbox`, `roamlink_inbox`) —
  the honest non-survivable case. A deliberate down-migration therefore
  PAIRS WITH a restore-from-backup (the RL-111 battery's
  export -> R2 -> scratch-restore path, §8 "backup/restore passes") and a
  declared maintenance window.
- **Acceptance is identical either way:** after a forward-fix OR a
  deliberate down-migration + restore, the SAME executable rule decides —
  `pnpm rollback:check` exit 0 (health + servable readiness + smoke
  green), then §8's checklist is re-walked for the affected items
  (migrations ledger manifest drift-free; stuck-outbox recovery and inbox
  batch progression exercised; smoke output recorded with the rolled-back
  SHA).

Real-run evidence (PA-011, 2026-09-23): the RL-112 real-pool round-trip
leg (RT-4) is no longer operator-pending — it ran and PASSED against the
operator-provided PostgreSQL (the PRIMARY durable target, over its direct
endpoint, verified read-only empty before the run): the baseline down
migrations were exercised on the real engine and behaved exactly as §9.2
pins (the down-to-base cycle drops the data tables; the forward
re-application converges the ledger to exactly the migration set,
digest-current). The deliberate down-migration in this run was
operator-commanded (the PA-011 work order) and destroyed only the
batteries' own seeded rows — the honest non-survivable case RT-2 encodes.
In the same run the RL-106 concurrency suite (7/7, 0 skipped) and the
RL-110 recovery battery's real leg (8/8, 0 skipped) passed on the same
database, zero real-wire fixes. Full record: `neon-provisioning.md` §6.1
(labels and counts only — zero credential values, RL-LOCK-016).

## 10. Honest-gaps discipline (AR-009)

Record in the deployment log every behavior NOT verified in this runbook
run (e.g. live QStash signature canonicalization, live Neon console
menus, R2 CORS for direct browser uploads). These are operator-phase
(RL-100+) verifications; the runbook is corrected in place — the code is
changed only when the wire contract itself drifted (single-site fixes in
the `@roamlink/provider-*` packages, re-run contract batteries).
