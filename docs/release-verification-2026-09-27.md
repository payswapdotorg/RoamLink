# RoamLink release verification — 2026-09-27 (PA-027 / PA-028 / PA-029)

The PA-wave's release-verification record, executed by the Tech Lead as gate
work (the gate artifacts are TL-owned per the W8A fence law). All evidence
below was produced by the runs cited; nothing is projected or promised.
Worker C could not be dispatched for this packet — the platform generation
outage (onset ~15:56 UTC 2026-09-27, probes every ~10 min all DOWN through
21:15) kept every fresh turn queued — so the TL executed the verification
legs directly and records them here.

## 1. Deployment evidence (PA-027)

- main @ `d3669cd` = PR #58 (PA-021, merge commit `b86eaf7`) + PR #59
  (PA-022, merge commit `d3669cd`). Both PRs carry the full TL gate
  verdicts in their bodies.
- The push triggered the production deploy (the repo's dual git binding:
  roamlink + roamlink-ten). Production alias:
  `https://roamlink-ten.vercel.app`.
- Wire battery (2026-09-27 ~20:58–21:15 UTC):
  - `/healthz` → 200 `{"status":"alive"}`
  - `/readyz` → 200 `{"status":"degraded:rate-limit","ready":true,...}`
    (database: healthy; migrations: healthy — 4 applied; rate-limit:
    degraded = the documented PA-028 gap, §3 below)
  - `/v1/notifications` (unauthenticated) → 401 (the auth boundary holds)
  - `/login` → 200 (the public login document renders)
- The deployed-browser acceptance run (§2.4) drove the production alias at
  21:01–21:09 UTC; the definitive build-identity proof is the post-PA-022B
  clean re-run (the alias serves the READY deployment of the pushed main;
  the run postdates the merge push by ~6 min).

## 2. The gate battery (all TL-executed, 2026-09-27)

### 2.1 PA-021 — `work/pa021-deployed-browser-acceptance` @ `4580e6e`

- LEG0 fetch+checkout PASS (single commit; parent == base `381f9bc`)
- LEG1 owned-surface audit PASS — 21 files, 0 outside (tests/acceptance/**
  + the root script + the lockfile importer + spec/deployment.md + the
  audit doc)
- LEG2 `corepack pnpm@10.0.0 check` PASS — 2,868 tests passed, 21
  named-skips (the AR-010 law), including the new package's selftest:
  15 tests with the real-browser leg driving headless Chromium 153 (no
  skip needed) and the named-skip CLI law verified
- LEG3 `node scripts/check-architecture.mjs` PASS
- TL diff review PASS — the honest-skip law (ACCEPTANCE_BASE_URL_NOT_
  CONFIGURED), the closed six-level vocabulary, the typed-panel contract,
  devDependencies only (Playwright as a devDep of the new package), no
  weakened tests
- VERDICT: **merged as PR #58**

### 2.2 PA-022 — `work/pa022-final-ux-closure` @ `2d9b6c5`

- LEG0 PASS (single commit; parent == base `381f9bc`)
- LEG1 scope-law audit PASS — 14 files, 0 outside (apps/web/** +
  tests/e2e/** + the audit doc)
- LEG2 check PASS — 2,857 tests passed, 21 named-skips; apps/web 270
  green (RL-114/RL-115 included — no discoverability regression);
  tests/e2e 54 green including the NEW hosted finish-form completion
  journey (the retry finds the prior draft and activates it — one goal,
  active, never a stack of duplicates)
- LEG3 architecture PASS
- TL diff review PASS — surface-level only, design language preserved;
  the honest middle states (goal-active-not-evaluated) fix real
  Home/Activity contradictions; PA-020 secondary degradation extended to
  the device notifications/SIM reads; the read-first find-or-create closes
  the onboarding retry-stacking-drafts defect; the two test-file assertion
  replacements audited NON-weakenings (a deterministic typed pin replacing
  a coincidental Promise.all race pin, 3 assertions replacing 2, the
  zero-command discipline held)
- VERDICT: **merged as PR #59**

### 2.3 Deployment gates (against https://roamlink-ten.vercel.app)

- `pnpm smoke` (RL-100): **7 passed, 0 failed** (healthz, readyz
  vocabulary, home surface, admin surface + auth gate, static assets,
  webhook ingress fail-closed 401)
- `pnpm rollback:check` (BASE_URL set): **4 passed, 0 failed** (including
  the embedded synthetic smoke 7)
- `pnpm demo:acceptance` (RL-117, clean invocation — the TL shell's
  stray SQLite DATABASE_URL unset): **12 rows — 7 green, 5 named-skip,
  0 needs-deployment, 0 red | the demo deployment is accepted** (the
  named-skips carry their operator-phase flips, AR-010)

### 2.4 The deployed-browser acceptance run (PA-021's instrument, TL-run)

`ACCEPTANCE_BASE_URL=https://roamlink-ten.vercel.app pnpm
acceptance:deployed` — 2026-09-27T21:01:48Z, driver "playwright chromium
153.0.8010.12 (headless)", both viewport classes, customer + owner
personas. Machine report: `tests/acceptance/.tmp/acceptance-report-
2026-09-27T21-01-48-124Z.json`.

- **56 legs, 0 leg failures, 2 relogins, 0 navigation retries.**
- Per-journey furthest level (desktop/mobile identical):
  - login → **user-visible-evidence**
  - onboarding → mutation-accepted (the enrollment durably accepted; the
    executed stage unreached — the honest multi-tick state)
  - goals → read-available (the create form correctly requires an
    executed device)
  - devices → mutation-accepted (the enroll accepted; no executed device
    in the read model to open the detail journey)
  - esim → honest stop (no executed device — the SIM journey cannot
    start; the surface records it)
  - connectivity → read-available
  - activity → read-available
  - plans-billing → surface-rendered (the commerce page fails closed on
    its uncomposed core read set — the typed refusal)
  - support → mutation-accepted (the case command accepted)
  - workspace → read-available (the connector enrollment is
    capability-gated on organization verification)
  - admin → surface-rendered (the admin session gate denies the owner
    persona — the fail-closed denial renders)
- a11y battery: touch-targets 30/30, tab-order 36/36, focus-visibility
  36/36, skip-link 28 pass + 8 named-skip, sidebar 14 pass + 4 named-skip,
  bottom-nav 14 pass + 4 named-skip; **heading-order 30 pass / 6 fail** —
  all six the SAME defect class: the admin console's access-denied panel
  renders its "Access denied" heading as h3 directly under the page h1
  (a level skip) on /console, /slo, /integration-health at both viewports.
- **Exit 1 — "LIES DETECTED"**: the no-lie law's teeth. The defect is
  PRE-EXISTING on the base (PA-022 touched apps/web only; the denied
  panel is apps/admin surface) — the new instrument found a latent
  a11y defect. **Remediation dispatched: work order PA-022B** (the
  denied-panel heading becomes h2 + a regression pin; rides the platform
  queue; the clean re-run follows its merge).

## 3. Provider enablement table (PA-028 — the honest states)

| provider | state | evidence |
|---|---|---|
| PostgreSQL (Neon) | **LIVE** | /readyz database: healthy, migrations: healthy (4 applied); the deployed host runs the real PostgreSQL path (demo:acceptance row 6) |
| Upstash Redis | **NOT CONFIGURED — correct-but-degraded** | /readyz rate-limit: degraded ("production mode requires an explicitly bound distributed rate limiter; the in-memory fallback is refused"); Redis is optional for correctness (row 10 green) — the accelerated path flips when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set |
| QStash | **NOT CONFIGURED — fail-closed** | the event-driven kicks degrade to the inline bounded sweeps (RL-093/094 batteries green through the cron route) |
| R2 | **NOT CONFIGURED — fail-closed** | the backup/restore real legs are env-gated (AR-010 named-skip, row 2) |
| ADCOS | **NOT CONFIGURED — fail-closed** | the compatibility probe honestly reports not-configured (its own exit-2 semantics, row 5) |
| Webhook signing | **NOT CONFIGURED — fail-closed** | every delivery is rejected 401 unsigned until ROAMLINK_WEBHOOK_SIGNING_KEYS is set (row 4 + the smoke's fail-closed check) |

The PA-028 Redis flip is **operator-blocked on credentials, not on code**:
the readiness wiring is complete (edge.rateLimiter binds the Upstash REST
client when the two env keys are present); the sandbox reset of 2026-09-27
10:30 UTC wiped both the VERCEL_TOKEN (the API env-upsert path) and the
Upstash credentials from the box. The flip procedure: upsert
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` on the Vercel
project (v10), redeploy, expect /readyz → `status: "ok"`.

## 4. The nine-item battery (PA-029 — handoff §12 + the completion definition)

1. **Architecture checks green** — PASS: `node scripts/check-architecture.mjs`
   green on both branches (PA-021 LEG3, PA-022 LEG3) and in the check
   battery's architecture phase.
2. **Mutation-route parity** — PASS: the parity invariants green in both
   full check batteries (2,868 / 2,857 passed; the CI invariant suite
   included).
3. **Real read models** — PASS: PA-024 suite green (in both batteries);
   wire spot-verified: /v1/notifications unauth 401 (the honest typed
   auth boundary); the plans-billing journey records the honest typed
   READ_MODEL_NOT_COMPOSED refusal (surface-rendered, not faked).
4. **Command execution path live** — PASS: the PA-025 seam evidenced —
   the hosted runtime's inline bounded sweeps advance accepted commands
   (the e2e hosted journeys green, 54 tests; the deployed run's legs
   record mutation-accepted with the honest executed-not-reached stop).
5. **Browser journeys** — PASS-WITH-FINDING: the PA-021 level report
   (§2.4) — 56 legs, 0 leg failures, per-journey furthest levels + honest
   stop reasons recorded; the a11y finding (admin denied-panel heading
   skip) is real, pre-existing, and remediation is dispatched (PA-022B).
6. **Smoke green** — PASS: 7/7 (§2.3).
7. **demo:acceptance green** — PASS: 12 rows — 7 green, 5 named-skip
   (AR-010), 0 red (§2.3).
8. **rollback:check green** — PASS: 4/4 (§2.3).
9. **ADCOS compatibility honest fail-closed** — PASS (the honest state):
   no keys configured; the probe reports not-configured (exit 2, its own
   semantics); recorded, never faked.

## 5. Standing operator actions (the credential names whose absence keeps
legs disabled)

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — flips /readyz
  to ok (the PA-028 gap: rate-limit degraded).
- `VERCEL_TOKEN` — restores the API env-upsert + deployment-record path
  (lost in the 2026-09-27 sandbox reset; the git-push deploy binding
  remains functional).
- `ROAMLINK_WEBHOOK_SIGNING_KEYS` (+ `ROAMLINK_WEBHOOK_ENVIRONMENT`) —
  the signed-delivery ingress (until then every delivery fails closed
  401).
- `QSTASH_TOKEN` + `QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY`
  (+ `QSTASH_URL`) — the event-driven kick plane (until then the inline
  bounded sweeps carry the obligations).
- `R2_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` +
  `R2_BUCKET` (+ optional `R2_ENDPOINT`) + a distinct
  `ROAMLINK_BACKUP_SCRATCH_DATABASE_URL` — the real backup/restore legs.
- `ADCOS_API_BASE_URL` + `ADCOS_CLIENT_ID` + `ADCOS_CLIENT_SECRET` +
  `ADCOS_WEBHOOK_SECRET` — the ADCOS compatibility gate.
- A demo `DATABASE_URL` (postgres://) on the verification box — unlocks
  the demo:acceptance env-carried rows (the TL box intentionally carries
  none; the gate's no-env mode is its designed honest partial).

## 6. What would flip each disabled leg (one paragraph)

Every disabled leg above is a credentials-upsert away from its flip: set
the two Upstash keys and /readyz turns ok (the code path is wired and
waits only on env); set the QStash surface and the kicks move from the
inline sweeps to the durable queue (the sweep batteries already prove the
obligation semantics); set the R2 + scratch-database surface and the
RL-111 restore legs run against the real objects; set the ADCOS quartet
and the RL-108 probe runs its compatibility walk; set the webhook signing
registry and the ingress starts accepting signed deliveries. None of
these flips requires a code change — the runtime is fail-closed by design
and each provider is optional-for-correctness, which is exactly why the
deployment is servable and accepted today with zero red rows.

## 7. Record

- Executed by: the Tech Lead (gate work; the workers' packets for
  PA-021/PA-022 were delivered to their branches during the platform
  outage and gated on the branch truth — the merge records live in PRs
  #58/#59; the workers' chat-line completion reports remain queued
  server-side behind the outage and are nice-to-have confirmations, not
  gating artifacts).
- PA-022B (the denied-heading remediation) dispatched 2026-09-27 ~21:05
  UTC; rides the platform queue; its merge triggers the clean deployed
  re-run (expected: exit 0, 0 a11y failures).
