# RoamLink deployment manifests & environment separation (RL-099)

This directory is the **hosted-deployment manifest layer** (per
`spec/repository-layout.md` hosted additions and `spec/deployment.md`).
It contains ONLY manifests, environment TEMPLATES (empty values) and
operator runbooks — never secrets, never credentials, never real
endpoints tied to an account.

```
infra/deployment/
  vercel.json                     Vercel project configuration (template)
  environments/                   one template per deployment.md §6 environment
    development.env.example
    preview.env.example
    demo.env.example
    production.env.example
  providers/                      per-provider env templates (RL-095..098)
    neon.env.example
    upstash-redis.env.example
    upstash-qstash.env.example
    cloudflare-r2.env.example
  runbooks/
    neon-provisioning.md          RL-095 operator runbook (real Neon account)
    deployment-runbook.md         RL-099 end-to-end deploy + verify runbook
                                  (§6b = the RL-100 synthetic smoke loop)
  smoke/                          the RL-100 synthetic smoke journey (zero-dep)
    run.mjs                       the runner (BASE_URL/API_URL from env; the
                                  root `pnpm smoke` script)
    selftest.mjs                  proves the runner (loopback stubs; the root
                                  `pnpm smoke:selftest` script)
  provider-wiring.md              port -> adapter -> env wiring manifest
  free-tier-constraints.md        deployment.md §5 as operational guidance
```

## Non-negotiable rules encoded here

1. **Secrets are NEVER committed.** Every `*.env.example` carries empty
   values and key-documentation only. Real values live in the target
   environment's secret store (Vercel project env vars / secret manager)
   and are entered per environment, per deployment.md §6.
2. **Provider rules (ADR-0003)**: PostgreSQL (Neon) is the durable source
   of truth; Redis is a bounded accelerator; QStash is retryable
   transport; R2 is large-object storage; Vercel is hosting/runtime only.
   Every provider sits behind a RoamLink port (see `provider-wiring.md`).
3. **Free-tier limits are operational guidance, never correctness
   logic** (`free-tier-constraints.md`, handoff §12 stop-rule).
4. Per-environment credentials are FULLY SEPARATE (database, Redis,
   QStash, R2, ADCOS, webhook secrets); production ADCOS credentials
   never enter preview.

## Deploying host

`apps/web` (plus `apps/admin` composition) is deployed by the host
composition decided at the Wave-6 integration gate; this directory stays
host-agnostic: `vercel.json` is the project configuration TEMPLATE the
deploying app adopts at RL-100+ deploy time.

## Runtime hardening wiring (RL-105/RL-107/RL-108, Wave 7B)

- **API edge (RL-105)** — the portal-host composition binds the DISTRIBUTED
  fixed-window limiter over the Upstash Redis REST port when
  `UPSTASH_REDIS_REST_URL`/`_TOKEN` are configured; without them the
  api-service's honest resolution law applies (in-memory fallback in
  non-production with a loud composition line; REFUSED in production — the
  readiness surface reports `degraded:rate-limit`, never a silent
  single-process downgrade). 429s carry the typed body + `retry-after`.
- **Worker host (RL-107)** — `services/workers` is the production drain
  process (outbox + inbox + reconciliation). Compose the outbox delivery
  channel with `QSTASH_TOKEN` + `ROAMLINK_OUTBOX_DELIVERY_DESTINATION`;
  without a channel the drain is honestly disabled (readiness degraded,
  records stay PENDING). The startup sweep (`recoverInFlight`) runs BEFORE
  the first claim on every process start — the AR-007/RL-093 restart
  discipline (see docs/deployment-recovery.md §1 "Process restart").
- **Maintenance cron (RL-107)** — `GET /api/maintenance/daily` (vercel.json)
  answers ONLY `Authorization: Bearer <CRON_SECRET>` (unset = every trigger
  refused, fail-closed). Inline mode performs ONE bounded
  `recoverInFlight` sweep + ONE bounded inbox drain per call (never a
  long-running serverless job, deployment.md §5); with
  `QSTASH_TOKEN` + `ROAMLINK_MAINTENANCE_DESTINATION` it kicks the sweeps
  event-driven with deterministic per-day job ids (cron retries are
  duplicates, RL-LOCK-014).
- **ADCOS compatibility probe (RL-108)** — run standalone
  (`pnpm --filter @roamlink/workers adcos:probe`) or as the worker host's
  readiness dependency. Env-configured (the four ADCOS keys, all-or-
  nothing; see environments/*.env.example); exit codes are DISTINCT
  (0 compatible | 1 incompatible, mutations fail closed | 2
  not-configured). Deployment check §7 "ADCOS compatibility gate runs
  against the configured endpoint" executes here.

- **Live command execution (PA-025)** — `POST /api/worker/tick` on the
  portal-host is the authenticated bounded worker-tick endpoint
  (`services/worker-endpoint`, an isolated service plane over the
  `services/workers` execution seam): it VERIFIES the QStash delivery
  signature before anything else (`QSTASH_CURRENT_SIGNING_KEY` /
  `QSTASH_NEXT_SIGNING_KEY`; unset = every delivery refused with the honest
  503, fail-closed) and then executes exactly ONE bounded tick per delivery
  (a `recoverInFlight` sweep + a capped `claimDue` batch through the
  command-executor delivery port + one bounded inbox batch + the
  max-duration partial-progress guard) — never a long-running serverless
  job (deployment.md §4). Accepted commands ADVANCE to `executed` (the
  CAS-guarded command-ledger write, resource recorded) and the read models
  serve real projections. Publish the recurring QStash schedule once with
  `pnpm --filter @roamlink/worker-endpoint schedule:publish`
  (`QSTASH_TOKEN` + `ROAMLINK_WORKER_TICK_DESTINATION` +
  `ROAMLINK_WORKER_TICK_CRON`; the cadence is a budgeted operator choice —
  see environments/demo.env.example). The production long-running workers
  host keeps the SAME seam unchanged.
