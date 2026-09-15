# RoamLink Architecture Lock

**Status:** FROZEN
**Version:** 1.0.0

If code, tickets, prompts, tests, or deployment decisions conflict with this document, implementation stops until an approved architecture change is recorded.

## RL-LOCK-001 — ADCOS is the connectivity authority
RoamLink must not duplicate or supersede ADCOS connectivity semantics.

## RL-LOCK-002 — One integration boundary
Application modules access ADCOS only through the RoamLink ADCOS integration boundary and its public contract types.

## RL-LOCK-003 — No duplicate identity authority
RoamLink may own customer/user/org/device identity for the experience domain, but it must not redefine ADCOS NodeID, credentials, or cryptographic identity semantics.

## RL-LOCK-004 — No duplicate session authority
RoamLink may project and describe connectivity sessions but may never become authoritative for ADCOS logical sessions.

## RL-LOCK-005 — No duplicate path/routing authority
RoamLink expresses desired outcomes and consumes selected-path evidence. It never chooses, commits, or mutates ADCOS NetworkPath/routing state.

## RL-LOCK-006 — No provider authority
RoamLink may model customer-facing provider information but provider-native state is external. Provider APIs cannot silently become RoamLink connectivity truth.

## RL-LOCK-007 — Experience intent is not ConnectivityIntent
RoamLink `ExperienceIntent` is a customer/domain abstraction. ADCOS `ConnectivityIntent` remains canonical for connectivity execution. Mapping must be explicit and versioned.

## RL-LOCK-008 — Payment is not delivery
Customer payment/order state is separate from reservation, path activity, delivery, usage, billable finality and ADCOS settlement.

## RL-LOCK-009 — Webhooks are signals, not truth
A webhook is durably admitted and verified, then reconciled against the canonical ADCOS resource where needed. Event arrival must not be treated as sufficient proof of physical delivery.

## RL-LOCK-010 — Evidence and freshness are first-class
All projected/external state retains provenance, authority, timestamps and freshness. Unknown is a valid state.

## RL-LOCK-011 — Device capability is evidence-based
The implementation cannot assume OS/radio capabilities not exposed by the platform. Unsupported controls degrade gracefully.

## RL-LOCK-012 — AI is advisory
AI may explain, rank, summarize or propose experience preferences, but it cannot authorize connectivity commands or override deterministic policy/authority boundaries.

## RL-LOCK-013 — No hidden provider SDK leakage
Provider SDKs belong behind appropriate integration/adapter boundaries. Core Experience/Commerce code must not depend on provider-specific implementation details.

## RL-LOCK-014 — Idempotent commands
Every cross-boundary mutation is correlation-ID and idempotency-key aware. Retries must not duplicate orders, intents, reservations, payments or webhook effects.

## RL-LOCK-015 — Offline/local-first degradation
Edge operation must preserve local observations and desired state while offline and converge when connectivity returns.

## RL-LOCK-016 — No secret leakage
Private keys, ADCOS credentials, provider secrets and subscriber credentials cannot enter projections, telemetry, logs, analytics payloads or user-visible diagnostics.

## RL-LOCK-017 — Versioned contracts
Public RoamLink and ADCOS integration contracts are versioned and additive-change tolerant.

## RL-LOCK-018 — Tests prove architecture
Conformance tests must fail when an implementation violates an authority or dependency lock, not merely when a happy path breaks.

## RL-LOCK-019 — Three-worker-safe ownership
Parallel work must operate on disjoint bounded contexts/contracts. Shared-authority edits require orchestrator serialization.

## RL-LOCK-020 — Architecture changes require ADR
Any change affecting ownership, state machines, cross-boundary semantics, security authority, or dependency direction requires an ADR and updates to the affected specs before implementation proceeds.

## Required review questions

Every PR/work item must answer:
- Which lock(s) does this rely on or affect?
- Which authority owns the state being changed?
- Is this a command, observation, projection, or derived explanation?
- Could this be duplicated, reordered, retried, delayed, or missing?
- What happens offline?
- What evidence proves success?
- Does the implementation introduce a second authority?
