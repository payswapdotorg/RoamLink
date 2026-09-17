# @roamlink/tests-security

The RL-074 **security/threat-model verification suite**: an executable
verification of the threat model in `spec/security.md` (its "Threat
priorities" list is the checklist). Every suite composes the REAL public
packages through their public surfaces (the §10 ADCOS fake is the only
external stand-in) and drives deterministic ATTACK FIXTURES with
expected-rejection assertions — negative proofs, plus the durable-state
consequences of each rejection.

Verdicts, findings and honest gaps are documented in
`docs/threat-model-verification.md`.

## Determinism rules

Testkit clock/ids, no sleeps, no network, no ambient randomness, no ADCOS
internals. Credential-marker literals in poisoned fixtures are assembled
from parts (the repo's own pre-commit secret-scan discipline).

## Suite catalog

| File | Threats covered | Representative negative proofs |
|---|---|---|
| `webhook-source-attacks.test.ts` | forged/replayed ADCOS webhooks (threat #1) + customer-webhook emission discipline | forged signatures (tampered + attacker-secret), unknown keys, replayed event ids, replay-window (stale + future), unsupported schema versions, oversized payloads, environment mismatch, malformed envelopes, header/envelope disagreement, missing headers — all rejected at inbox admission with zero durable side effects; a raw ADCOS payload cannot pass the durable-transition origin contract (notifications + enterprise emission) |
| `tenant-actor-boundary.test.ts` | confused-deputy cross-tenant commands (#2) + privilege escalation through admin tooling (#10) | cross-tenant reads/writes denied at every public surface (auth repos, authorization service, /v1 app surface incl. tenant-header spoofing, admin console, enterprise API keys) with no existence oracle; member→admin escalation fails closed and is audited server-side |
| `secret-material-leakage.test.ts` | leaked ADCOS/provider credentials (#5), compromised edge device (#6), malicious provider metadata (#7) | the RL-054 scanner sweep across EVERY persisted surface the flows produce (zero findings, after the scanner is proven able to fail on poisoned fixtures); no secret-shaped value in audit/notifications/errors; SecretMaterial redacted from every serialization path; secrets-boundary failures never echo values; edge offline outbox stores ciphertext only. Records FINDINGS RL-074-F1/F2 |
| `auth-session-attacks.test.ts` | token expiry, stale evidence, rank demotion (RL-004 + RL-041) | expiry enforced at the exact boundary; revoked credentials never grant access; login idempotency attacks (replay = same session once; key reuse under a different command = typed conflict); unconstructible lifetime bounds; AUTHENTICATED fabrication structurally unreachable; weaker evidence never demotes; stale/insufficient evidence never gates; rotation fail-closed. Records FINDING RL-074-F3 |
| `audit-chain-integrity.test.ts` | audit-chain tampering (RL-051) | mutation/reorder/splice/unknown-field each break verification at the exact first-broken sequence; the full-tail-rewrite limit pinned honestly; security-relevant mutations always audited with actor/tenant/correlation; append-only by construction |
| `privacy-retention.test.ts` | privacy/retention enforcement (RL-054 + RL-010) | data past its retention class purged per policy (tombstone vs hard-delete); consent-gated categories refused without consent; a lax policy cannot be constructed (structural stricter-control invariant); access control denies expired/tombstoned/wrong-purpose; explicit erasure idempotent; retention never negotiable by the record |
