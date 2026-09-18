# @roamlink/provider-redis

The **bounded ephemeral-coordination adapter surface** (RL-096) — Upstash
Redis as a strictly optional accelerator, exactly per `spec/deployment.md`
§2/§8 and ADR-0003.

## The rule this package enforces by construction

> Redis is NEVER the durable source of truth. It accelerates: rate
> limiting, hot cache, short-TTL coordination, abuse protection.

The port shape makes violations unrepresentable:

- **Every write carries an explicit TTL** — there is no unbounded set.
- **Values are size-bounded** (default 64 KiB admission limit).
- **Keys are safe labels** (same discipline as resilience limiter keys).
- **No durable structures** — no streams/lists/queues here; durable work
  belongs to the durable-jobs port (RL-097) and the PostgreSQL ledger.

The system **stays correct without Redis**: consumers treat failures as a
signal to degrade to their non-accelerated path (deployment.md §7 "Redis
is optional for correctness").

## Surfaces

| Export | Role |
|---|---|
| `EphemeralCoordinationPort` | The replaceable port (get / setWithTtl / delete / incrementWithTtl / timeToLiveMs / ping) |
| `InMemoryEphemeralCoordination` | Deterministic fake (explicit clock, capacity bounds) for tests/local |
| `UpstashRedisRestClient` | Hosted REST adapter (pinned wire contract, injected `fetchLike`, typed `RedisProviderError` with suppressed details) |
| `tryParseUpstashRedisEnv` | Fail-closed `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` handling (secret-redacting config object) |
| `defineEphemeralCoordinationContract` | The REUSABLE contract battery — both shipped implementations and any future replacement provider run the same tests (ADR-0003 migration rule) |
| `DistributedFixedWindowLimiter` | Distributed admission over the accelerator, emitting @roamlink/resilience `LimiterDecision`s keyed per subject, epoch-aligned windows, TTL-bounded state |
| `createRedisHealthCheck` | Observability composition — an accelerator being `down` must never by itself fail readiness |
| `FIXED_WINDOW_INCREMENT_LUA` | The ONE pinned Lua script (INCRBY + guaranteed PEXPIRE, atomic) shared by client and tests |

## Contract tests (port parity)

The same behavioral battery runs against (a) the in-memory fake and (b)
the Upstash REST client over an in-memory REST protocol stand-in — wire
encoding, Bearer auth, result/error envelope and error mapping are all
exercised with zero network and a testkit clock. See
`test/port-parity.test.ts`.

## Honest wire-contract notes (AR-009)

The REST client pins: POST + JSON command-array body, `Bearer` auth,
`{"result"|"error"}` envelope, and a single EVAL script. These match the
Upstash REST API's published contract; live confirmation against a real
Upstash account is the operator's RL-100+ phase (no cloud credentials
exist in the build sandbox). Any drift is a single-site client fix —
consumers are insulated by the port.
