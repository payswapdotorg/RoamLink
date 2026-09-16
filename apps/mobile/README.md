# @roamlink/mobile — the RoamLink mobile/edge UX shell (RL-062)

The observation, experience and synchronization agent surface
(spec/mobile.md): the edge desired-state loop

```
local context -> evaluate RoamLink experience policy -> desired action
(capability-gated) -> queued command (encrypted offline outbox) -> server /
ADCOS integration -> authoritative result -> local projection update
```

rendered as a **mobile/edge shell, not a network authority** — there is no
radio, path, session, routing, provider or ADCOS identity logic anywhere in
this app (RL-LOCK-003/004/005; spec/mobile.md "Principle").

## What it is

| Piece | File | Responsibility |
|---|---|---|
| Platform probe port | `src/platform-probe.ts` | The ONLY platform seam: host-bound adapters report what the OS/device exposes; the deterministic in-memory fake is the reference implementation |
| Enrollment publication | `src/enrollment.ts` | The signed/versioned/expiring capability-snapshot publication (spec/mobile.md "Capability discovery"): the RL-040 snapshot verbatim, its canonical SHA-256 digest, and an HMAC signature through the injectable `MobileEnrollmentSigner` port — the signing key NEVER enters the shell |
| The shell | `src/shell.ts` | `MobileEdgeShell`: observation cycles into RL-041 snapshot chains, policy evaluation (the RL-043 `LocalExperiencePolicy` port), capability-gated actions (local execution or encrypted-outbox queueing toward the server/ADCOS integration), explicit sync + replay-safe crash recovery, authoritative-result intake, the bounded telemetry ring, and the freshness-first read models |
| Views | `src/views.ts` | Framework-free typed screens on the app-kit HTML core: connectivity (freshness ALWAYS rendered), the capability truth table with gate previews, controls with observation/manual guidance, the ciphertext-only outbox view, the honest action history |

## Honesty rules (enforced by tests)

- **Freshness always** — every read re-evaluates freshness at the query
  instant; FRESH degrades to STALE monotonically; UNKNOWN is presented,
  never hidden; nothing is ever rendered as healthy without evidence
  (RL-LOCK-010, spec/security.md "Fail-safe defaults").
- **Capability-gated actions only** — every executed OR queued action passes
  the RL-043 admission gate against the current evidence-based snapshot;
  INFERRED/STALE/UNKNOWN evidence never allows an action (RL-LOCK-011). A
  lying executor (success without evidence) is converted into a typed
  failure — physical success is only ever declared WITH platform/ADCOS
  evidence.
- **Offline degrades honestly** — observation continues, desired-state
  changes queue into the encrypted offline outbox (ciphertext-only at rest,
  dedupe metadata in the clear), retries back off and dead-letter after the
  bounded policy, and convergence happens through explicit `sync`
  (RL-LOCK-015).
- **Degraded controls show observation/manual guidance** — a
  `requires-permission` or unavailable control renders the closed-vocabulary
  reason plus platform guidance text; the control never fakes success and
  never hides why it is unavailable.
- **Queued is not executed** — the projection keeps `synced` (the server
  accepted the command) strictly separate from `executed-observed`
  (platform-evidenced physical success).
- **Host-agnostic** — ids, cipher keys, signer, executor, probe and sync
  transport are all injected; app sources never touch node builtins. The
  package dependency set is pinned by `tests/architecture`
  (`wave4-b-package-boundaries.test.ts`): `@roamlink/app-kit`,
  `@roamlink/contracts`, `@roamlink/edge`, `@roamlink/edge-actions`,
  `@roamlink/edge-connector` — nothing else.

## Known limitations / follow-ups

- The enterprise-connector negotiation surface (RL-044) is consumed through
  `@roamlink/edge-connector` types; a dedicated enterprise screen composing
  a real MDM connector is follow-up platform work (Wave 5+).
- Real iOS/Android/desktop probe + executor adapters bind the ports in the
  host applications; this package ships only the deterministic fakes.
- Server-bound desired-state changes land in `packages/enterprise`'s
  managed-edge enrollment surface on the other side of the sync transport
  (RL-063).
