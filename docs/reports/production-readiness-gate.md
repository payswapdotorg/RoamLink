# RoamLink Production Readiness Gate — Verdict Report (RL-081)

- **Gate:** RL-081 — production readiness gate (`scripts/release/production-gate.mjs`)
- **Run commands:** `pnpm production-gate` (equivalently
  `node scripts/release/production-gate.mjs`); this report's evidence was produced with
  `node scripts/release/production-gate.mjs --full-report`, which evaluates the
  production criteria for evidence even when the MVP prerequisite has already failed —
  it never converts a failure into a pass.
- **Machine artifact:** `docs/reports/mvp-gate.json` (from the prerequisite run, embedded
  in the production artifact) and `docs/reports/production-gate.json`
  (schema `roamlink/release-gate@1`; every number below is a pointer into these).
- **VERDICT: FAIL — exit code 1.** The hard prerequisite (RL-080 MVP release gate)
  fails on this tree, so the production gate fails. No standard was weakened to pass.

---

## 1. Judgment table

| Requirement class | Verdict | Why |
| --- | --- | --- |
| MVP prerequisite (RL-080) | **FAIL** | MVP-3 (§11 SLO instrumentation + dogfood/load references) — see `docs/reports/mvp-release-gate.md` |
| PRD-1 Security/threat verification | PASS (1 disclosed gap ← AR-009) | `@roamlink/tests-security` 57/57 green; threat matrix 10 rows / 19 VERIFIED verdicts; 5 recorded findings all dispositioned |
| PRD-2 Deployment/recovery runbook | PASS (0 gaps) | cold start, crash recovery, backup/restore, dependency-failure all suite-proven + documented; `@roamlink/tests-deployment` 26/26 green |
| PRD-3 Observability | PASS (2 disclosed gaps ← AR-001, AR-002) | health/readiness composition honest; structured logging + §11 SLO wiring gaps disclosed |
| PRD-4 Docs completeness | PASS (1 disclosed gap ← AR-003) | README quickstart verified script-by-script; CHANGELOG drafted; spec/current-state.md claims stale |
| PRD-5 Accepted-risk registry | PASS (0 gaps) | registry valid, complete coverage, no orphans, no self-coverage, high risks fully dispositioned |

**Zero uncovered failures** among the production criteria: every unmet row carries an
explicit, validated accepted-risk record. The gate still fails overall — honestly —
because the MVP prerequisite is a hard precondition that no accepted risk can waive.

## 2. Per-criterion evidence (artifact `criteria[PRD-*].rows`)

### PRD-1 — Security/threat verification (RL-074)

- `SEC:suite` PASS — `@roamlink/tests-security` green (57/57 tests).
- `SEC:negative-proofs` PASS — threat-priority matrix: 10 threat rows, 19 VERIFIED
  verdict tokens (docs/threat-model-verification.md).
- `SEC:findings-recorded` PASS — 5 recorded findings across the verification docs
  (RL-073-DEFECT-1, RL-074-F1/F2/F3, RL-075-F1), each dispositioned via the registry
  (checked by PRD-5).
- `SEC:honest-gaps` **GAP ← AR-009** — 10 documented inherent-infrastructure limits
  (5 threat-model, 5 deployment) that cannot be closed on this tree; each has its
  strongest deterministic proxy verified and its boundary pinned by an explicit test.

### PRD-2 — Deployment/recovery runbook (RL-075)

- `DEPLOY:cold-start` PASS — suite `tests/deployment/test/cold-start-shutdown.test.ts`
  present; runbook documents the mode (cold start, CS-).
- `DEPLOY:crash-recovery` PASS — suite present; runbook documents crash recovery (M-5).
- `DEPLOY:backup-restore` PASS — suite present; runbook documents Backup/Restore (B-1).
- `DEPLOY:dependency-failure` PASS — suite present; runbook documents ADCOS-unreachable
  (D-1).
- `DEPLOY:suite` PASS — `@roamlink/tests-deployment` green (26/26 tests).

### PRD-3 — Observability

- `OBS:logs-correlation` **GAP ← AR-001** — the dogfood scenarios do not wire the
  observability structured logger (no `@roamlink/observability` import in
  `tests/dogfood` executable text). Correlation IDs ARE proven end-to-end through audit
  events; structured-log records are not part of the dogfood evidence.
- `OBS:health-readiness` PASS — health/readiness composition verified honest
  (degraded ≠ ready, unknown ≠ healthy, no-data SLOs never healthy; H-1..H-4).
- `OBS:slo-wiring` **GAP ← AR-002 (high)** — all 9 §11 SLOs lack operational wiring
  (the current MVP-gate blocker; see the MVP report §3).

### PRD-4 — Docs completeness

- `DOCS:quickstart` PASS — README quickstart reproduces a local dogfood run from a
  clean clone with copy-paste commands; every referenced pnpm script exists.
- `DOCS:current-state` **GAP ← AR-003** — `spec/current-state.md` still claims
  "no production feature implementation started" / "Repository state: greenfield",
  contradicting the 25 implemented packages. `spec/*` is outside the release-gate
  worker's editable scope by dispatch — recorded as an explicit gap for the Tech Lead.
- `DOCS:changelog` PASS — CHANGELOG drafted for the MVP release (scope, surfaces,
  verification stack, known gaps).

### PRD-5 — Accepted-risk registry (`docs/reports/accepted-risks.json`)

- `RISK:registry` PASS — 9 records, schema + required fields + severity vocabulary
  checked.
- `RISK:no-orphans` PASS — every registry entry maps to an evaluated criterion row.
- `RISK:findings-coverage` PASS — every recorded finding (RL-073-DEFECT-1, RL-074-F1,
  RL-074-F2, RL-074-F3, RL-075-F1) is referenced by an accepted-risk record.
- `RISK:high-disposition` PASS — the one high-severity risk (AR-002) carries exposure
  bounds, owner, review milestone and remediation path.

## 3. Accepted-risk registry (explicit, visible, never hidden)

| ID | Severity | Criterion / row | Subject | Remediation owner |
| --- | --- | --- | --- | --- |
| AR-001 | medium | PRD-3 / OBS:logs-correlation | Dogfood scenarios don't wire the structured logger (correlation IDs proven via audit events only) | Tech Lead |
| AR-002 | **high** | PRD-3 / OBS:slo-wiring | No §11 SLO instrumented or referenced in dogfood/load — the current MVP-gate blocker | Tech Lead |
| AR-003 | medium | PRD-4 / DOCS:current-state | spec/current-state.md stale claims ("greenfield", "no implementation") | Tech Lead |
| AR-004 | medium | PRD-1 (finding RL-074-F1) | Secret-shaped provider references accepted into commerce payment records | Tech Lead |
| AR-005 | low | PRD-1 (finding RL-074-F2) | AuthSessionRecord.tokenDigest field name scanner-flagged (value is a SHA-256 digest) | Tech Lead |
| AR-006 | low | PRD-1 (finding RL-074-F3) | Double session revocation surfaces typed CAS conflict instead of idempotent no-op | Tech Lead |
| AR-007 | medium | PRD-2 (finding RL-075-F1) | Outbox records stranded in DELIVERING have no public recovery path | Tech Lead |
| AR-008 | medium | PRD-2 (finding RL-073-DEFECT-1) | Batched inbox drains cannot progress past the first batch of a larger backlog | Tech Lead |
| AR-009 | medium | PRD-1 / SEC:honest-gaps | Inherent-infrastructure verification limits (10 documented honest gaps of RL-074/075) | Tech Lead |

Each record in `docs/reports/accepted-risks.json` carries full justification, exposure
bounds, remediation path, owner and review milestone. Gaps that need real
infrastructure (AR-009's items — anchored audit checkpoints, PostgreSQL driver,
network-level load, multi-process concurrency) are recorded here as explicit
accepted-risk lines, per the RL-081 contract: visible, not hidden.

## 4. Path to green (for the Tech Lead)

1. Wire §11-named SLOs through `@roamlink/observability` in `tests/dogfood` and/or
   `tests/load` with assertions referencing each SLO (AR-002 remediation) →
   RL-080's MVP-3 turns green → the MVP gate passes → this gate's prerequisite passes.
2. Wire the correlated logger into the dogfood world and assert log records carry the
   correlation id (AR-001 remediation).
3. Refresh `spec/current-state.md`'s status block to match the implemented tree
   (AR-003 remediation — minutes of work; the DOCS:current-state row then turns green
   with no gate change).
4. Disposition or fix AR-004..AR-008 (each has a pinned minimal reproducer) as
   prioritized by the Tech Lead; AR-009's items close as real infrastructure lands.

With 1–3 done, both gates pass with zero uncovered failures and only the explicitly
accepted risks remaining.

## 5. How to reproduce

```bash
pnpm production-gate                          # exit 1 on this tree (prerequisite fail)
node scripts/release/production-gate.mjs --full-report   # complete criteria evidence
echo $?                                        # 1 — the honest verdict
```

JSON summary on stdout; durable artifacts at `docs/reports/production-gate.json` (which
embeds the MVP verdict) and `docs/reports/mvp-gate.json`.

## 6. Bottom line

**The production readiness gate FAILS on this tree (exit 1)** — inherited honestly from
the RL-080 MVP gate's §11 SLO criterion. The production-specific standards themselves
show zero uncovered failures: security and deployment verification are green with all
findings explicitly dispositioned, the runbook modes are suite-proven, health/readiness
composition is honest, the README quickstart reproduces from a clean clone, the
CHANGELOG is drafted, and every gap that cannot be closed by this worker is an explicit
accepted-risk line (AR-001..AR-009) with owner, exposure bounds and remediation. The
verdict is reported as-is: visible, not hidden.
