# Provider wiring manifest (RL-099)

The single map from RoamLink PORT -> chosen ADAPTER -> environment keys.
Per ADR-0003 every provider is an adapter behind a replaceable port; a
replacement keeps the port and the contract tests, changes only the
adapter construction (and this manifest).

| Port (authority rule) | Shipped adapters | Environment keys | Package |
|---|---|---|---|
| **Durable PostgreSQL** (durable source of truth — ADR-0003) | driver path (RL-090) configured via `parseNeonConnectionString`; health via `createNeonHealthCheck` | `DATABASE_URL`, `NEON_DIRECT_URL` | `@roamlink/provider-neon` |
| **EphemeralCoordinationPort** (bounded accelerator; optional for correctness) | `InMemoryEphemeralCoordination` (tests/local), `UpstashRedisRestClient` (hosted) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | `@roamlink/provider-redis` |
| **DurableJobDeliveryPort** (retryable async transport; never business-state authority) | `InMemoryJobDeliveryQueue` (tests/local), `UpstashQStashClient` (hosted); receivers verify via `QStashSignatureVerifier` | `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_URL` | `@roamlink/provider-qstash` |
| **DurableJobSchedulePort** (recurring delivery of the bounded worker tick; transport cadence, never correctness — PA-025) | `InMemoryJobDeliveryQueue` (tests/local), `UpstashQStashClient` (hosted; the pinned schedule API); the setup path publishes the tick cadence to the receiver URL | `QSTASH_TOKEN`, `QSTASH_URL` + `ROAMLINK_WORKER_TICK_DESTINATION`, `ROAMLINK_WORKER_TICK_CRON` (publish once: `pnpm --filter @roamlink/worker-endpoint schedule:publish`) | `@roamlink/provider-qstash` + `@roamlink/worker-endpoint` |
| **ObjectStoragePort** (large artifacts; never relational authority) | `InMemoryObjectStorage` (tests/local), `S3ObjectStorageClient` over R2's S3-compatible API (hosted) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | `@roamlink/provider-r2` |
| **Web hosting/runtime** (hosting only — never a domain authority) | Vercel (Hobby for demo; see free-tier-constraints.md) | n/a (Vercel project config: `vercel.json` template) | `infra/deployment` |

## Composition rules

1. **The system stays correct without Redis and QStash.** Hosts compose
   the accelerator/delivery adapters only when their env keys are present;
   otherwise the non-accelerated / non-delivered path runs. Only the
   PostgreSQL path is required (RL-090 real persistence).
2. **No provider SDK imports outside the `@roamlink/provider-*` packages.**
   Domain/application code depends on the ports. (RL-LOCK-013: no hidden
   provider SDK leakage.)
3. **Every adapter implementation passes the SAME contract battery**
   exported from its package (`define*Contract`) — the ADR-0003
   replacement rule.
4. **Health composition**: hosts register `createNeonHealthCheck` (or the
   persistence driver's liveness probe + the migration-ledger check),
   `createRedisHealthCheck`, `createQStashHealthCheck` (RL-100, over the
   read-only `TransportProbePort`) and `createObjectStorageHealthCheck` —
   each ONLY when that adapter is actually composed — with the
   @roamlink/observability HealthRegistry. PostgreSQL + migrations are
   REQUIRED (their down state is `not-ready:<dep>`); every
   accelerator/transport (Redis/QStash/R2) is OPTIONAL (its down state is
   `degraded:<dep>` — an accelerator being down must never by itself fail
   readiness). The composed vocabulary is
   `ready | degraded:<dep,...> | not-ready:<reason,...>`; the synthetic
   smoke (`smoke/run.mjs`) asserts it on the deployed stack.
