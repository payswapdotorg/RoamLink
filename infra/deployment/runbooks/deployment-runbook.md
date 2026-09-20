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

## 10. Honest-gaps discipline (AR-009)

Record in the deployment log every behavior NOT verified in this runbook
run (e.g. live QStash signature canonicalization, live Neon console
menus, R2 CORS for direct browser uploads). These are operator-phase
(RL-100+) verifications; the runbook is corrected in place — the code is
changed only when the wire contract itself drifted (single-site fixes in
the `@roamlink/provider-*` packages, re-run contract batteries).
