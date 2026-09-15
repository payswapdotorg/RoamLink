# @roamlink/edge

The edge capability contract package (RL-040, Layer C). Contracts only - the
platform adapters are RL-043 (Wave 3) and the sync/outbox engine is RL-042
(Wave 2). The only dependency is `@roamlink/contracts` (Wave-0 foundation).

## Surface

| Module | Provides |
|---|---|
| `ids` | edge-owned opaque references (`EdgeDeviceRef`, snapshot/action/desired-state/outbox ids) built on the Wave-0 ID machinery |
| `version` | `EDGE_CONTRACT_VERSION` + additive-compatibility check for edge records (RL-LOCK-017) |
| `capability/capability-name` | CLOSED 11-name capability vocabulary (spec/architecture.md §7) |
| `capability/capability-model` | platform families, per-capability platform scope + evidence requirement registry |
| `capability/evidence` | typed minimal platform-evidence payload (closed kind vocabulary, safe labels, no secrets) |
| `capability/capability-snapshot` | immutable, versioned `EdgeCapabilitySnapshot` with per-capability status/evidence-class/observed-at, in-scope totality, deterministic digest |
| `capability/capability-gating` | `assertCapability(snapshot, requirement)` -> allow / deny-with-reason / degrade; evidence-class ranking; freshness-aware |
| `action/device-action` | `DeviceActionRequest` (capability requirement + parameters + Wave-0 envelope + dedupe key) and honest `DeviceActionResult` (`executed-observed` requires platform evidence) |
| `sync/desired-state` | local desired-state record contract (supersession chain, last-known freshness) |
| `sync/outbox` | encrypted-outbox record contract (ciphertext-only payload, key REFERENCE never material, retry policy + state invariants, clear dedupe metadata) |

## Key design decisions

- **Evidence-based, never assumed (RL-LOCK-011).** A capability entry may
  only claim a non-unknown status with real platform evidence (kind !== 
  `none`, evidence class !== UNKNOWN). `unknown` is a valid, honest state.
  The gate denies or degrades on absence of evidence - never assumes.
- **Honest action results (spec/mobile.md).** `executed-observed` is only
  constructible WITH a real platform-evidence payload; `accepted` carries
  neither evidence nor reason (acceptance is not physical success);
  gate-blocked outcomes map deny -> `unsupported`, degrade -> `degraded`.
- **Heuristics never gate (RL-LOCK-011/012).** Evidence-class ranking:
  AUTHENTICATED > OBSERVED > REPORTED > DERIVED; INFERRED/STALE/UNKNOWN can
  never support an allow, and a requirement minimum must itself be one of
  the four gating-capable classes.
- **Platform scope is a map, not a claim.** The per-capability platform
  scope says where the capability question is DEFINED. The `other` family
  defers entirely to evidence. Scope never implies availability.
- **Encrypted outbox shape (RL-LOCK-015/016).** Payloads are ciphertext-only
  (algorithm id + key reference + base64url); a plaintext command envelope
  is not even a valid field of the record. Dedupe metadata stays in the
  clear so retries dedupe without decryption (RL-LOCK-014).
- **Versioned, additive-change tolerant (RL-LOCK-017).** Records carry a
  `ContractVersion`; same-major records not newer than the implemented
  minor parse; anything else fails closed.
- **Disjoint ownership (RL-LOCK-019).** This is the EDGE-side contract. The
  Experience-domain `DeviceCapabilitySnapshot` aggregate (RL-010) is a
  separate record owned by the device registry; the two are not merged.

## Scope guard

This package must not gain platform adapters (RL-043), encryption
implementations (RL-042), AI/heuristic decision logic (RL-LOCK-012), ADCOS
client behavior, or domain aggregates owned by other workers.
