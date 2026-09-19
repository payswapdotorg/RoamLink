# @roamlink/provider-qstash

The **durable-jobs delivery adapter surface** (RL-097) — Upstash QStash as
retryable async transport, exactly per `spec/deployment.md` §2/§4/§8 and
ADR-0003.

## The rule this package enforces by construction

> QStash is a delivery mechanism, NEVER business-state authority. Durable
> truth lives in the caller's PostgreSQL-backed ledger.

- The port (`DurableJobDeliveryPort`) is **transport-only**: it exposes
  `enqueue` and nothing else. The caller durably records the job FIRST
  (idempotency key = the durable job id, RL-LOCK-014); the transport
  never invents state and never reports it.
- **Idempotency is carried, not owned**: ledger-backed implementations
  (the fake, and later the Postgres-ledger composition) enforce
  (jobId, payload) idempotency/conflict semantics; the pure client
  carries the key as the `Upstash-Deduplication-Id` header (proved in
  wire tests).
- **Retries are safe and bounded**: non-2xx/unreachable receivers are
  retried with exponential backoff; an exhausted attempt budget lands in
  a **dead-letter path** with an explicit redrive — jobs can never strand
  silently (the §17 outbox-stranding finding is the anti-pattern).
- **Every delivery is signed and receivers VERIFY before acting** —
  webhook-inbox verification rigor: constant-time compare, replay window
  in BOTH directions, closed failure codes, value-free errors,
  current+next signing-key rotation.

## Surfaces

| Export | Role |
|---|---|
| `DurableJobDeliveryPort` | The replaceable delivery port (transport-only) |
| `InMemoryJobDeliveryQueue` | Deterministic fake simulating the full delivery loop (push, backoff, DLQ, redrive) with SIGNED deliveries; explicit clock |
| `UpstashQStashClient` | Hosted transport (pinned publish API, dedupe header, injected `fetchLike`, typed `QStashProviderError` with suppressed details) |
| `QStashSignatureVerifier` | Receiver-side verification (`renderQStashSignatureHeader` / `signQStashDelivery` are the signing counterparts) |
| `tryParseQStashEnv` | Fail-closed `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` / `QSTASH_URL` handling (secret-redacting) |
| `defineDurableJobDeliveryContract` | The reusable transport battery (ADR-0003 replacement rule) |
| `canonicalJson` | Stable-key-order JSON (delivery + signature are byte-exact) |

## Job flow (deployment.md §4)

```
webhook admission / scheduled work
  -> durable queue (PostgreSQL ledger, caller-owned)
  -> enqueue (transport, idempotency key carried)
  -> QStash delivery (signed, retried by the provider)
  -> receiver endpoint VERIFIES the signature, then acts (2xx)
  -> failures retry with backoff -> dead-letter -> explicit redrive
```

## Honest wire-contract notes (AR-009)

The client pins the publish route/headers and the verifier pins the
signature scheme (`t=<sec>,v1=<hex>`, HMAC-SHA256-hex over `<t>.<body>`)
in SINGLE sites, matching the provider's published contract. Live
confirmation against a real QStash account is the operator's RL-100+
phase (no cloud credentials exist in the build sandbox). Drift is a
contained, fully-tested correction — receivers and enqueuers depend only
on this package's surface.
