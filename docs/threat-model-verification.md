# RoamLink Threat-Model Verification (RL-074)

**Work item:** RL-074 — Security/threat-model verification
**Suite:** `tests/security` (`@roamlink/tests-security`, runs as part of `pnpm test`)
**Source checklist:** `spec/security.md` ("Threat priorities" is the authority this
verification executes); cross-referenced with `spec/architecture-lock.md`,
`spec/adcos-integration.md`, `spec/api.md`, `spec/data-model.md` and
`spec/definition-of-done.md` ("Security").
**Method:** every suite composes the REAL public packages through their public
surfaces (the §10 ADCOS fake is the only external stand-in), drives
deterministic ATTACK FIXTURES, and asserts expected REJECTIONS plus the
durable-state consequences of each rejection (negative proofs). Deterministic
throughout: testkit clock/ids, no sleeps, no network, no ADCOS internals.

---

## 1. Threat → suite → verdict matrix

The verdict vocabulary: **VERIFIED** (mechanically proven by a negative-proof
test on the current tree), **VERIFIED (proxy)** (the strongest mechanical proxy
where the full threat cannot be simulated deterministically), **GAP** (documented
below with why).

### spec/security.md "Threat priorities" (the checklist)

| # | Threat | Suite / attack IDs | Verdict |
|---|--------|--------------------|---------|
| 1 | Forged/replayed ADCOS webhooks | `webhook-source-attacks` W-1..W-10 | **VERIFIED** — forged signatures (tampered hex AND an attacker-controlled secret under a registered key id), unknown key ids, replayed event ids, replay-window violations (stale AND future-stamped), unsupported schema versions, oversized payloads, environment mismatch, malformed closed envelopes, header/envelope event-id disagreement and missing headers are ALL rejected at inbox admission with the pinned closed error codes, with the durable state provably untouched (zero admissions, zero extended records, zero projections; rejections leave audit rows). Positive control W-0 proves the suite passes on honest deliveries. |
| 2 | Confused-deputy cross-tenant commands | `tenant-actor-boundary` T-1..T-11 | **VERIFIED** — cross-tenant reads/writes denied at EVERY public surface: auth repositories (T-1), the authorization service (T-2/T-3/T-4), the apps' `/v1` API surface incl. tenant-header spoofing (T-9, 404 with no existence oracle), the admin console (T-10), the enterprise API-key boundary (T-11). Privilege escalation on admin operations (member → org commands, owner-grant self-promotion, suspended-org escape abuse) fails closed with typed errors and audited denials (RL-061). |
| 3 | Stale projection causing unsafe customer action | RL-071 delay suites (referenced) + `auth-session-attacks` A-1/A-7 + `dependency-failure` D-2 (RL-075) | **VERIFIED (split)** — freshness decay/STALE handling is RL-071's verified territory; this wave adds the evidence-discipline half (stale/insufficient evidence never gates an action — A-7) and the query-instant expiry semantics (A-1). |
| 4 | Duplicated reservation/order/payment commands | RL-071 duplicate suites (referenced) + `auth-session-attacks` A-3, `webhook-source-attacks` W-3, `backup-restore` B-3 | **VERIFIED (split)** — duplicates at every boundary are RL-071's verified territory; this wave adds the auth-session idempotency attacks (envelope replay returns the SAME session once; idempotency-key reuse under a different command is a typed conflict — A-3) and the webhook replay dedupe with exactly-one projection effect (W-3). |
| 5 | Leaked ADCOS/provider credentials | `secret-material-leakage` S-1..S-7 | **VERIFIED (with findings F1/F2)** — the RL-054 scanner (first proven able to fail on poisoned fixtures: password fields, PEM markers, GitHub/AWS/JWT/Bearer value shapes) finds ZERO secret-shaped material across every persisted surface the flows produce (projections, inbox records incl. raw payloads, outbox, audit events, sessions, credentials, users, notifications, commerce read models, enterprise key records, edge offline outbox ciphertext). Live tokens/passwords appear in NO fixture. **FINDINGS RL-074-F1/F2 recorded** (see §3). |
| 6 | Compromised edge device | `auth-session-attacks` A-5/A-6/A-8, `secret-material-leakage` S-7 | **VERIFIED (proxy)** — a compromised device can lie about observations, but it CANNOT fabricate AUTHENTICATED evidence (the closed evidence-kind map cannot produce it — structural proof over the map + the engine's defense-in-depth tripwire), cannot demote a raised evidence class with weaker lies (A-6), and its offline outbox holds only ciphertext (S-7). Secrets rotation is fail-closed (retired versions stop granting; the active pointer moves — A-8). The residual (a compromised device lying within OBSERVED) is bounded by design: local evidence is never authoritative. |
| 7 | Malicious provider metadata | `secret-material-leakage` S-6 | **VERIFIED (with finding F1)** — a PEM-shaped provider reference is rejected by the payment record's safe charset; a JWT-shaped opaque reference is ACCEPTED and persisted (FINDING RL-074-F1, §3) but IS flagged by the repo's own scanner afterward (detection exists, enforcement does not run at that admission point). |
| 8 | Dependency/SDK supply-chain compromise | `tests/architecture` + `tests/conformance` RL-LOCK-012/013 (referenced, not duplicated) | **VERIFIED (by reference)** — AI-SDK and provider-SDK import bans are existing conformance locks; this wave adds the runtime tripwire observation (the AUTHENTICATED map invariant — A-5) rather than duplicating structural scans. |
| 9 | Loss/reordering of offline commands | `tests/simulation` partition suite (referenced) + `auth-session-attacks` A-3 | **VERIFIED (by reference)** — RL-071's verified territory; the auth-session replay discipline adds the command-idempotency half. |
| 10 | Privilege escalation through support/administrative tooling | `tenant-actor-boundary` T-5/T-6/T-10, `webhook-source-attacks` W-11 | **VERIFIED** — member→admin command escalation denied with server-side audited denials; the suspended-org escape is scoped to `org:manage` only (a member cannot ride it, and it never grants other permissions); the admin console resolves the actor session BEFORE fetching surface data (a denied actor triggers exactly one request); customer-facing webhooks CANNOT be emitted from unverified/ADCOS-shaped origins (the closed `roamlink_state_transition` vocabulary leaves no passing shape — W-11 proves both the notifications and the enterprise emission paths reject raw ADCOS payloads). |

### spec/security.md section rules

| Section | Rule | Suite / IDs | Verdict |
|---|---|---|---|
| Webhooks | source auth, replay protection, event-id dedupe, schema validation, payload-size limits, durable inbox admission | W-1..W-10 | **VERIFIED** (each rule has its own rejection proof) |
| Webhooks | customer webhooks emitted only from verified durable transitions | W-11/W-12 | **VERIFIED** (RL-LOCK-009 enforced structurally at both emission boundaries; legitimate transitions emit HMAC-authenticated, replay-protected deliveries that verify at the receiver, and redelivery dedupes) |
| Authorization | tenant boundary, actor permissions, resource ownership, idempotency before state | T-1..T-11 | **VERIFIED** |
| Audit | security-relevant mutations recorded with actor/tenant/command/correlation/outcome; secrets never logged | `audit-chain-integrity` I-1..I-8, `secret-material-leakage` S-3 | **VERIFIED** (with the tail-rewrite GAP, §4) |
| Credential rules | secrets injected through the runtime secret mechanism; short-lived, revocable edge credentials; server-side service credentials | A-1/A-2/A-8, S-4/S-5 | **VERIFIED** (sessions bounded [1min,12h], digest-only storage, revocation effective immediately, rotation fail-closed) |
| Fail-safe defaults | unknown/unverifiable state never healthy; incompatible contracts fail closed for mutations | RL-075 `health-readiness` H-1..H-4, `dependency-failure` D-1/D-5 | **VERIFIED** (in the deployment verification — cross-referenced) |
| Privacy/retention (spec/data-model.md) | classified records, purpose limitation, consent gating, expiry enforcement, audited access | `privacy-retention` P-1..P-7 | **VERIFIED** (retention windows enforced with tombstone/hard-delete semantics per category; consent-less location/network-identifier records REFUSED at admission; a lax policy cannot even be constructed — structural stricter-control invariant; access control denies expired/tombstoned/wrong-purpose records; every decision audited atomically) |

---

## 2. Findings (recorded — fix ownership: Tech Lead)

Per the verification-wave contract, a failed verification is a FINDING with a
minimal reproducer, not a fix. All four findings are pinned in the suites as
the current observable behavior, so the eventual fixes flip explicit
assertions.

### RL-074-F1 — secret-shaped provider references are accepted into commerce payment records

- **Where:** `packages/domain-commerce` `CustomerPayment.providerReference`
  (charset `[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}`).
- **What:** a malicious provider returning a JWT-shaped string (or any
  seamless token shape the charset permits — dots and base64url) as its
  payment "provider reference" is ACCEPTED at admission and PERSISTED into
  the commerce read model. `spec/data-model.md` "Privacy" says "Secrets and
  credentials are never persisted in ordinary domain tables."
- **Exposure bound:** the value is provider-supplied opaque REFERENCE data,
  not a RoamLink credential; PEM-shaped values (with spaces) are rejected by
  the charset. The repo's own RL-054 scanner flags the persisted record
  afterward (`$.providerReference`, detector `value-marker`) — detection
  exists, enforcement does not run at this admission point.
- **Minimal reproducer** (`tests/security/test/secret-material-leakage.test.ts`, S-6):
  `payments.recordPayment(..., { providerReference: "eyJhbGciOiJIUzI1NiJ9.attacker.payload" })`
  → resolves `pending` (accepted); `scanForSecretMaterial(persistedPayment)`
  → one finding at `$.providerReference`.
- **Candidate remediation:** run `assertNoSecretMaterial` over
  provider-supplied reference fields at commerce admission, or further
  restrict the charset (e.g. no `.`).

### RL-074-F2 — the auth session record's `tokenDigest` field name is scanner-flagged

- **Where:** `packages/auth` `AuthSessionRecord.tokenDigest`.
- **What:** the RL-054 secret-shape scanner flags the FIELD NAME (key-name
  detector, "token" fragment). The VALUE is a SHA-256 digest of the session
  token — non-invertible, and possession of the digest is NOT possession of
  the credential (`verifySession` requires the token; only its digest is
  compared) — so the SUBSTANCE of RL-LOCK-016 holds (proven: the live token
  appears in no persisted record; the digest is 64-hex).
- **Why it is still a finding:** the naming discipline is inconsistent with
  the enterprise package's deliberate `keyRef`/`signingKeyRef` naming
  ("named `signingKeyRef` so persisted records stay RL-054 scanner-clean").
  A repo-wide scanner sweep therefore cannot be wired as a CI gate over ALL
  persisted records without an allow-list decision.
- **Minimal reproducer** (S-2): `scanForSecretMaterial(sessionRecord)` →
  one finding at `$.tokenDigest` (key-name), zero findings for the value.
- **Candidate remediation:** rename (e.g. `tokenVerificationDigest`) or make
  an explicit, documented scanner allowance for digest fields. Orchestrator
  call.

### RL-074-F3 — double session revocation via a second command surfaces a typed CAS conflict

- **Where:** `packages/auth` `AuthenticationService.revokeSession`.
- **What:** revoking an ALREADY-REVOKED session through a second, distinct
  command throws `ConflictError (REVISION_CONFLICT)` instead of an idempotent
  no-op: the AGGREGATE `revoke()` is idempotent, but the service re-saves the
  unchanged record whose revision no longer satisfies the stored+1
  precondition. The behavior fails CLOSED (the session stays revoked;
  nothing reopens) — an ergonomics/idempotency gap, not a vulnerability.
- **Minimal reproducer** (`tests/security/test/auth-session-attacks.test.ts`, A-2):
  revoke twice with distinct envelopes → second call rejects
  `REVISION_CONFLICT`; `verifySession` still rejects with `SESSION_REVOKED`.
- **Candidate remediation:** skip the save when the record is already
  revoked (return the recorded outcome).

*(RL-075-F1, the outbox DELIVERING-strand finding, is recorded in
`docs/deployment-recovery.md`.)*

---

## 3. Honest gaps

Threats or threat-halves that cannot be verified mechanically on this tree,
with the strongest proxy that IS verified:

1. **Audit full-tail rewrite (I-5).** An attacker who can rewrite the ENTIRE
   audit tail AND recompute every digest defeats a bare hash chain — the
   `@roamlink/audit` package documents this as its KNOWN LIMIT ("a hash chain
   without an external anchor detects any tamper that does not rewrite the
   entire subsequent tail; periodic digest publication (checkpointing) is
   future work"). The suite pins the limit EXACTLY (the fully re-signed tail
   verifies) so an anchored implementation flips the assertion. Proxies that
   ARE verified: single-field mutation, reordering, splicing and unknown-field
   injection are all detected at the exact first-broken sequence (I-1..I-4).
2. **Timing side channels.** The auth suite proves the account-existence
   oracle is closed at the ERROR level (unknown email, wrong password and
   suspended account all produce the identical `AUTHENTICATION_FAILED`), but
   wall-clock timing differences (hash cost, repository lookup latency) are
   not measurable deterministically and are not asserted. The in-memory
   adapters make such measurement meaningless anyway; a timing analysis
   against the production password hasher is future operational work.
3. **Denial-of-service volumes.** RL-073's load suites verify the
   complexity invariants under volume (O(1) per event, bounded budgets);
   this wave verifies the ADMISSION POLICY under attack (payload-size
   limits, replay windows, closed vocabularies) but not network-level
   exhaustion — out of scope for an in-process deterministic suite.
4. **Secrets at rest in a real backend.** The secrets boundary is verified
   against the in-memory fake (redaction from every serialization path,
   value-free failure taxonomy, rotation semantics). A vault-backed
   adapter's at-rest encryption and access logging is deployment work not
   present on this tree; the PORT discipline (values enter only through
   the boundary) is what is verifiable now and is verified.
5. **Webhook signing-key compromise.** The suites prove a verifier
   rejection never echoes the HMAC secret and that unknown keys fail
   closed; what cannot be simulated is the OPERATIONAL response to an
   actual key compromise (emergency rotation of `ADCOS_WEBHOOK_SECRET`
   across a fleet). The rotation mechanics themselves are verified through
   the secrets boundary (A-8).

## 4. How to run

```bash
pnpm -C tests/security test        # all six suites (57 tests)
pnpm -C tests/security lint
pnpm -C tests/security typecheck
```

Every attack fixture is a deterministic negative proof: the suite fails if
the attack is admitted, if the durable state changes on a rejection, or if
an emission boundary accepts an unverifiable origin.
