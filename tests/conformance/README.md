# @roamlink/tests-conformance

The RL-070 **authority conformance suite**: the executable proof of the
architecture locks (RL-LOCK-018: "Conformance tests must FAIL when an
implementation violates an authority or dependency lock, not merely when a
happy path breaks").

## Layout

One suite per lock (`test/lock-*.test.ts`):

| Suite | Lock |
|---|---|
| `lock-001-adcos-only-authority.test.ts` | RL-LOCK-001 — ADCOS is the connectivity authority |
| `lock-002-one-integration-boundary.test.ts` | RL-LOCK-002 — one integration boundary |
| `lock-003-006-authority-duplication.test.ts` | RL-LOCK-003/004/005 — no duplicate identity/session/path authority |
| `lock-006-no-provider-authority.test.ts` | RL-LOCK-006 — no provider authority |
| `lock-007-intent-separation.test.ts` | RL-LOCK-007 — ExperienceIntent is not ConnectivityIntent |
| `lock-008-payment-not-delivery.test.ts` | RL-LOCK-008 — payment is not delivery |
| `lock-009-webhooks-signals.test.ts` | RL-LOCK-009 — webhooks are signals, not truth |
| `lock-010-evidence-freshness.test.ts` | RL-LOCK-010 — evidence and freshness are first-class |
| `lock-011-capability-evidence.test.ts` | RL-LOCK-011 — device capability is evidence-based |
| `lock-012-ai-advisory.test.ts` | RL-LOCK-012 — AI is advisory |
| `lock-013-no-provider-sdk-leakage.test.ts` | RL-LOCK-013 — no hidden provider SDK leakage |
| `lock-014-idempotent-commands.test.ts` | RL-LOCK-014 — idempotent commands |
| `lock-015-offline-convergence.test.ts` | RL-LOCK-015 — offline/local-first degradation |
| `lock-016-no-secret-leakage.test.ts` | RL-LOCK-016 — no secret leakage |
| `lock-017-versioned-contracts.test.ts` | RL-LOCK-017 — versioned contracts |
| `lock-019-worker-safe-ownership.test.ts` | RL-LOCK-019 — three-worker-safe ownership |

RL-LOCK-018 is the meta-lock this package IS (its existing proofs live in
`tests/architecture`); RL-LOCK-020 (ADR process) is governance, not
mechanically testable before an ADR exists.

## The negative-proof discipline

Every suite proves its lock in two modes:

1. **Green proof (default):** the current tree satisfies the lock. Behavioral
   suites assert the closed vocabularies/records reject violating inputs;
   structural suites scan the real repository (manifests + sources).

2. **Negative proof (red-on-violation):** each lock carries a violating
   fixture. Set the environment variable

   ```bash
   ROAMLINK_CONFORMANCE_VIOLATION=<LOCK-ID> pnpm -C tests/conformance test
   ```

   (e.g. `ROAMLINK_CONFORMANCE_VIOLATION=RL-LOCK-008`) to toggle exactly
   that lock's fixture on:

   - **Behavioral suites** flip the expectation to the violating side — the
     conforming tree then FAILS the assertion (e.g. a payment carrying a
     `reservationState` field is now expected to be accepted; the closed
     record vocabulary refuses, so the suite goes red). If the
     implementation ever actually violated the lock, the DEFAULT assertion
     (rejection expected) would fail instead — the suite is bound to the
     violation in both directions.
   - **Structural suites** scan the real tree PLUS a virtual overlay
     carrying the violating file (a competing lifecycle definition, a
     direct `@roamlink/adcos` import from an application module, a provider
     SDK import, a committed private key, a sibling-authority manifest
     dependency) — the scan finds the violation and the suite goes red
     without dirtying the working tree.

   A toggled run is expected to be red in exactly the one suite whose lock
   id was named; every other suite stays green.

## Where a lock is not mechanically testable

- **RL-LOCK-012 (AI is advisory):** no AI component exists in the tree yet.
  The suite documents and executes the strongest proxies: (1) no AI/LLM SDK
  dependency anywhere in production sources (the supply-chain shape), (2)
  the advisory surface (`ExperienceDecision`, RL-013) is evidence-weighted
  with STALE/UNKNOWN weighing zero and carries no command/authorization
  capability, (3) advisory computation is deterministic (no ambient
  authority channel).
