# RoamLink MVP Release Gate — Verdict Report (RL-080)

- **Gate:** RL-080 — MVP release gate (`scripts/release/mvp-gate.mjs`)
- **Run command:** `pnpm mvp-gate` (equivalently `node scripts/release/mvp-gate.mjs`)
- **Machine artifact:** `docs/reports/mvp-gate.json` (schema `roamlink/release-gate@1`; every
  number quoted below is a pointer into that artifact)
- **Run at:** `generatedAt` in the artifact (UTC; the gate reruns the full verification
  stack, so every verdict here is backed by a fresh end-to-end run)
- **VERDICT: FAIL — exit code 1.** The gate is exit-faithful: any failure → non-zero.
  No criterion was weakened, skipped or reinterpreted to obtain a pass.

---

## 1. Judgment table

| Criterion | Requirement (spec/definition-of-done.md) | Verdict | Failed rows |
| --- | --- | --- | --- |
| MVP-1 | Every work item RL-001..RL-075 represented on `main` with tests green | **PASS** | 0/40 |
| MVP-2 | Every architecture lock RL-LOCK-001..020 covered by conformance suites | **PASS** | 0/20 |
| MVP-3 | Every §11 SLO instrumented + at least one dogfood/load assertion referencing it | **FAIL** | 9/9 |
| MVP-4 | spec/api.md public API documentation consistent with actual exported contracts | **PASS** | 0/14 |

The gate as a whole **fails** because MVP-3 fails. All five verification-stack steps
(install → lint → typecheck → test → architecture:check) ran green; the failure is a
criterion failure, not an infrastructure failure — which is exactly what a release gate
is for.

## 2. Verification-stack steps (dependency order, from the artifact's `steps`)

| Step | Command | Result | Evidence |
| --- | --- | --- | --- |
| install | `pnpm install --frozen-lockfile` | PASS (exit 0) | artifact step `install` |
| lint | `pnpm lint` (every workspace package) | PASS (exit 0) | artifact step `lint` |
| typecheck | `pnpm typecheck` (every workspace package) | PASS (exit 0) | artifact step `typecheck` |
| test | `pnpm test` (all 36 suites) | PASS — **36 suites green, 1831/1831 tests** | artifact step `test` → `details.suites` |
| architecture | `pnpm architecture:check` | PASS (exit 0) | artifact step `architecture` |

Suite-count pointers (`steps[].details.suites` in the artifact; totals per vitest):

- Verification waves: conformance **107** (RL-070), simulation **29** (RL-071),
  dogfood **9** (RL-072), load **12** (RL-073), security **57** (RL-074),
  deployment **26** (RL-075), architecture **94**, release-gates **59** (RL-080/081, new).
- Package suites (all green, per-package counts in the artifact): adcos 50, admin 13,
  app-kit 54, audit 14, auth 62, commerce-connectivity 22, compat 20, contracts 97,
  domain-commerce 78, domain-experience 112, edge 124, edge-actions 52, edge-connector 37,
  enterprise 71, integration 105, intent-compiler 49, mobile 43, notifications 19,
  observability 60, persistence 49, projections 37, reconciliation 72, resilience 34,
  retention 52, secrets 25, testkit 36, web 14, webhook-inbox 37.

## 3. Per-criterion evidence

### MVP-1 — PASS (40/40 work-item rows)

Every work item RL-001..RL-075 is represented in the tree (its packages/suites/docs
exist) and its owning suites ran green in the gate's test step. Row-by-row pointers:
artifact `criteria[MVP-1].rows` (one row per item, e.g. `RL-074 | Security/threat-model
verification — represented; owning suite(s) green`). The representation manifest lives
in `scripts/release/lib/work-items.mjs`.

### MVP-2 — PASS (20/20 locks; one coverage addition disclosed)

Every lock RL-LOCK-001..020 is covered by a mapped suite file that exists, references
the lock id, and whose owning package ran green (artifact `criteria[MVP-2].rows`,
each row's `evidence` names the exact file and the green suite count):

- RL-LOCK-001..017, RL-LOCK-019 → `tests/conformance/test/lock-*.test.ts`
  (owner `@roamlink/tests-conformance`, 107/107 green).
- RL-LOCK-018 → `tests/architecture/src/scan.ts` +
  `tests/architecture/test/forbidden-adcos-imports.test.ts`
  (owner `@roamlink/tests-architecture`, 94/94 green).
- RL-LOCK-020 → `tests/release-gates/test/criteria/mvp/lock-coverage.test.ts`
  (owner `@roamlink/tests-release-gates`, 59/59 green). **Disclosure:** this coverage
  was ADDED by RL-080 itself — before this gate no mechanical coverage existed anywhere
  (`tests/conformance/README.md` documented the lock as governance-only). The row
  summary in the artifact carries the same disclosure.

### MVP-3 — FAIL (9/9 SLO rows fail) — the gate-blocking criterion

Requirement: every SLO in `spec/architecture.md` §11 instrumented by observability
primitives with at least one dogfood/load assertion referencing it. Evidence
(artifact `criteria[MVP-3].rows`; comment-stripped scans of tree code,
`tests/dogfood`, `tests/load`):

| §11 SLO | Instrumentation in tree code | Dogfood/load assertion |
| --- | --- | --- |
| time-to-usable-connectivity | 1 hit — the app-kit UI **fake** seed (not observability wiring) | NONE |
| minutes-without-usable-connectivity | NONE | NONE |
| manual-interventions-per-session-day | NONE | NONE |
| successful-automatic-recovery-rate | NONE | NONE |
| intent-satisfaction-rate | NONE | NONE |
| connectivity-cost-per-useful-hour-gb-where-available | NONE | NONE |
| stale-unknown-state-duration | NONE | NONE |
| provider-access-failover-success | NONE | NONE |
| support-incidents-attributable-to-connectivity-orchestration | NONE | NONE |

Honest reading: the SLO *machinery* is real and green (`@roamlink/observability` 60/60;
`tests/release-gates/test/contract-deep.test.ts` constructs, evaluates and composes all
nine §11 SLOs through the real primitives — health/metrics/correlated logging, no-data
never healthy), but **no end-to-end suite references any §11 SLO and no product surface
wires §11-named SLOs**. Closing this requires editing `tests/dogfood`/`tests/load`
and/or `packages/*` — completed work-item packages outside the release-gate worker's
editable scope (dispatch: only `scripts/release/`, `tests/release-gates/`,
`docs/reports/` may be created). Per the dispatch contract the failed criterion is a
**finding for the Tech Lead**, recorded with full remediation path as accepted risk
**AR-002** (high) in `docs/reports/accepted-risks.json`. The MVP gate deliberately does
NOT accept risk coverage: definition-of-done criteria are pass/fail, not waivable.

### MVP-4 — PASS (14/14 rows)

`spec/api.md` vs the actual exported contracts (artifact `criteria[MVP-4].rows`;
deep-checked mechanically in `tests/release-gates/test/contract-deep.test.ts`):

- All 10 documented representative resources exported:
  `/v1/connectivity`, `/v1/devices`, `/v1/experience-intents`, `/v1/notifications`,
  `/v1/orders`, `/v1/organizations`, `/v1/payments`, `/v1/products`,
  `/v1/subscriptions`, `/v1/users` (→ `/v1/users/me`).
- Mutation-outcome vocabulary is exactly `accepted/executed/delivered/billable-final`.
- Every mutation carries the §5 command envelope (request/correlation/idempotency ids,
  actor/tenant context, optimistic version).
- Customer webhooks: HMAC-SHA256-authenticated, replay-protected, emitted from durable
  state transitions only.
- 9 additive route templates beyond the representative list — allowed by
  spec/api.md "Representative resources" + RL-LOCK-017 additive tolerance.

## 4. Gate machinery is itself tested

`@roamlink/tests-release-gates` — **59/59 green** (part of the gate's own test step):

- `test/mvp-gate.test.ts` (28): engine aggregation, failure propagation, critical-step
  short-circuit, artifact emission, exit-code faithfulness — on committed fixtures
  (`fixtures/vitest-summary-{pass,fail}.txt`, `fixtures/mini-repo*`); evaluator
  correctness proven against a clean mini-repo AND a violations mini-repo.
- `test/production-gate.test.ts` (18): registry validation (incl. self-coverage
  rejection), coverage application (covered gaps vs uncovered failures), prerequisite
  short-circuit, `--full-report` semantics.
- `test/contract-deep.test.ts` (8): spec/api.md vs the REAL app-kit/enterprise route
  tables, the four-stage vocabulary, the command envelope executed through the real
  planning functions, and every §11 SLO constructed + evaluated + composed through
  `@roamlink/observability`.
- `test/criteria/mvp/lock-coverage.test.ts` (5): the full RL-LOCK map incl. the new
  RL-LOCK-020 ADR-process check.

All machinery tests are deterministic: no network beyond the clone, no clock
dependence (the engine's clock is injectable).

## 5. How to reproduce

```bash
pnpm mvp-gate          # runs the whole stack + criteria; exit 1 on this tree
echo $?                # 1 — the honest verdict
```

JSON summary goes to stdout; the durable artifact is `docs/reports/mvp-gate.json`.

## 6. Bottom line

**The MVP release gate FAILS on this tree (exit 1).** Forty work-item rows are
represented with 1831/1831 tests green, all twenty architecture locks are covered, and
the public API surface matches its spec — but the §11 SLO criterion is not met: no
dogfood/load assertion references any §11 SLO. That is the single blocker, it is fully
diagnosed above, and its remediation (wire §11-named SLOs through
`@roamlink/observability` in `tests/dogfood`/`tests/load`) is documented as AR-002 for
the Tech Lead. The verdict is reported as-is: visible, not hidden.
