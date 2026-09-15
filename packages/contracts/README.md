# @roamlink/contracts

The lowest-level shared contract package (RL-002). All other RoamLink packages
depend on it. It contains **no domain logic and no business authority**
(RL-LOCK-003: no duplicate identity authority; RL-LOCK-007: ExperienceIntent
is NOT ConnectivityIntent - nothing in this package models connectivity).

## Surface

| Module | Provides |
|---|---|
| `brand` | nominal branding machinery (`Branded<Tag>`) |
| `ids/roamlink-ids` | 18 opaque RoamLink-owned ID types + parsers/guards |
| `ids/foreign-refs` | `AdcosIntentRef`, `AdcosContractRef`, `AdcosLeaseRef`, `AdcosResourceId`, `AdcosOfferRef`, `AdcosReservationRef`, `AdcosSessionRef`, `AdcosPathRef`, `AdcosEventId`, `AdcosDeliveryId` |
| `ids/tenant` | `TenantId` (`org:<uuid>` / `usr:<uuid>`), `ActorId`, scope helpers |
| `ids/command-ids` | `CommandId`, `CorrelationId`, `IdempotencyKey` |
| `time/utc-instant` | `UtcInstant` (canonical ISO-8601 Z, ms precision), strict parsing |
| `evidence/evidence-class` | frozen vocabulary AUTHENTICATED / OBSERVED / REPORTED / DERIVED / INFERRED / STALE / UNKNOWN |
| `errors` | 9-kind error taxonomy with `reason` codes + `retryable` classification |
| `envelope/command-envelope` | §5 command envelope (idempotent commands, RL-LOCK-014) |
| `versioning` | `ContractVersion` (MAJOR.MINOR), `Revision`, additive-compat helper |
| `serialization/canonical-json` | deterministic canonical JSON (sorted keys) |
| `serialization/digest` | SHA-256 hex digests over canonical JSON |
| `freshness` | observedAt / receivedAt / freshUntil / FRESH-STALE-UNKNOWN (RL-LOCK-010) |
| `env/env-schema` | fail-closed env validation matching `.env.example` exactly |

## Key design decisions

- **RoamLink IDs** are canonical lowercase RFC 9562 UUID text (the exact
  `crypto.randomUUID()` / PostgreSQL `uuid` form). Parsers reject non-canonical
  and nil-UUID forms; they never repair. Foreign refs use a conservative
  charset (`[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}`) until RL-030 pins the real
  ADCOS grammar; widening is an additive change.
- **Nominal typing** makes a `UserId` / `AdcosIntentRef` / `TenantId` mix-up a
  compile error. Foreign refs are never interchangeable with RoamLink IDs.
- **Timestamps** are ms-precision UTC instants. Naive/local time (no zone
  designator) is rejected outright; explicit `±HH:MM` offsets are accepted and
  canonicalized to `Z`.
- **UNKNOWN is a valid state** for evidence and freshness - never an error,
  never a false success.
- **Error messages never echo values** - only field/key names and expected
  shapes (RL-LOCK-016). The env object stores secrets in true private class
  fields; `String(env)`, `util.inspect(env)` and `JSON.stringify(env)` are all
  redacted.
- **Canonical JSON** only accepts JSON-native values (plain objects, arrays,
  strings, finite numbers, booleans, null). Dates/Maps/class instances are
  rejected with a path-precise error; convert instants to `UtcInstant` strings
  first. Same value -> same bytes -> same digest, always.

## Compatibility (RL-LOCK-017)

`CONTRACTS_CONTRACT_VERSION` is the package contract version (`0.1`).
Additive changes (new exports, new optional fields) bump the MINOR; breaking
changes bump the MAJOR. Consumers must tolerate unknown additive fields within
the same major. `isAdditiveCompatible(baseline, candidate)` implements the
check used by compatibility gates.

## Consumption notes

- The package exports TypeScript source (`src/index.ts`) - the intended
  internal-package pattern for this monorepo. Consumers must use a TS-aware
  runtime/bundler (vitest, tsx, bun, esbuild-based pipelines). All source is
  erasable-syntax-only (enforced by lint), so Node's native type stripping
  remains viable for services that want it.
- `serialization/digest` uses `node:crypto` (synchronous). A WebCrypto-based
  async variant for browser/edge runtimes would be an additive extension.
- Consumers compiling this source need `@types/node` available (any Node
  server package already has it).
- The env schema is side-effect free; call `parseEnv(process.env)` at startup.

## Scope guard

This package must not gain domain logic, persistence, or ADCOS client
behavior. Projection records, intent compilation, ADCOS request/response
schemas and identity resolution belong to their own work items (RL-003+,
RL-030+, RL-004+).
