# @roamlink/testkit

Deterministic test primitives for RoamLink (RL-040 platform scaffolding).
The only runtime dependency is `@roamlink/contracts` — no third-party test
libraries, no domain logic, no business authority.

## Surface

| Module | Provides |
|---|---|
| `clock` | `Clock` port, `SystemClock`, monotonic `DeterministicClock` (injectable Wave-0 `UtcInstant` values) |
| `ids` | `IdGenerator` port, `SequenceIdGenerator`, `DeterministicUuidGenerator`, `deterministicUuidFromSeed` |
| `recorder` | generic in-memory `Recorder<TEvent>`, `CommandEnvelopeRecorder` (query by command/correlation/idempotency identity, attempt counting for RL-LOCK-014 tests) |
| `fixtures/contracts-fixtures` | deterministic builders for Wave-0 contract types: UUID/tenant/command ids, `UtcInstant`, `Freshness`, `CommandEnvelope` (+ plain form) |

## Key design decisions

- **Determinism first.** Same seed -> same value, on every machine and run.
  The deterministic UUID form (`00000000-0000-4000-8000-XXXXXXXXXXXX`)
  matches the Wave-0 canonical UUID grammar and is never the nil UUID, so it
  passes every `parseCanonicalUuidAs`-based parser.
- **Valid by construction.** Fixture builders run the real contracts parsers,
  so a broken default fails at the fixture, not in an unrelated test.
- **History cannot be rewritten.** `CommandEnvelopeRecorder` stores frozen
  plain copies; mutating the source envelope after recording has no effect.
- **Monotonic test time.** `DeterministicClock` refuses to move backwards
  (`ConflictError`), mirroring real time semantics that freshness and retry
  logic depend on.

## Scope guard

This package must not grow domain logic, platform adapters or assertions
about business behavior. It exists to make RoamLink's own tests deterministic
(spec/definition-of-done.md "Deterministic test data").
