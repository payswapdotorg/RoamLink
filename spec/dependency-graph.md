# Dependency Graph

## Critical path

`RL-001 -> RL-002 -> RL-003 -> RL-004 -> {RL-010, RL-011, RL-020}`

`RL-010 + RL-011 -> RL-012 -> RL-013`

`RL-001 + RL-002 + RL-003 -> RL-030 -> {RL-031, RL-032, RL-033} -> RL-034 -> RL-035 -> RL-036`

`RL-002 -> RL-040 -> RL-041 -> RL-042 -> RL-043`

`RL-004 + RL-003 -> {RL-050, RL-051, RL-053, RL-054}`

`RL-021 + RL-022 + RL-023 + RL-036 -> RL-060 / RL-061 / RL-063`

`RL-034 + RL-035 + RL-041 + RL-043 -> RL-062`

`{all feature work} -> RL-070..075 -> RL-080 -> RL-081`

## Parallel waves

### Wave 0 — serial foundation
Orchestrator owns RL-001 and RL-002. No domain worker begins code that creates incompatible primitives.

### Wave 1 — three workers
- **Worker A:** RL-004, RL-010, RL-011.
- **Worker B:** RL-003, then RL-030.
- **Worker C:** RL-040 and platform/security scaffolding that depends only on RL-002.

### Wave 2
- **Worker A:** RL-012, RL-013, RL-020, RL-021.
- **Worker B:** RL-031, RL-032, RL-033, RL-034.
- **Worker C:** RL-041, RL-042, RL-050, RL-051, RL-052, RL-053.

### Wave 3
- **Worker A:** RL-022, RL-023, RL-014.
- **Worker B:** RL-035, RL-036.
- **Worker C:** RL-043, RL-044, RL-054.

### Wave 4
- **Worker A:** RL-060, RL-061.
- **Worker B:** RL-062, RL-063.
- **Worker C:** RL-070, RL-071 and shared contract verification.

### Wave 5 — integration gate
Orchestrator serializes RL-072, RL-073, RL-074, RL-075 and release gates RL-080/RL-081.

## Parallel safety rule

Workers may run concurrently only when their work-item dependencies are satisfied and they do not edit the same authority-owned module. Shared contract changes are orchestrator-owned. A worker that discovers a missing dependency must stop that branch rather than silently inventing a substitute.

## Merge order

Merge lower-level contracts before consumers. Prefer small, reviewable commits. The orchestrator reviews each merge against the architecture locks before opening the next wave.


## Post-gate waves

### Wave 6 — customer shell + hosted runtime

Worker A:
RL-082 -> RL-083 -> RL-084 -> RL-085 -> RL-086; RL-087 and RL-088 follow RL-083.

Worker B:
RL-089 -> RL-090; RL-003 -> RL-091 -> RL-092; RL-091 -> RL-093 -> RL-094.

Worker C:
RL-095 + RL-096 + RL-097 + RL-098 + RL-099 -> RL-100.

Wave 6 integration gate:
RL-083 + RL-090 + RL-092 + RL-100.

### Wave 7 — journey completion

Worker A: RL-101 -> RL-102; RL-103; RL-104.

Worker B: RL-105; RL-106 after RL-091/092; RL-107 after RL-090/093/094; RL-108 after real endpoint configuration.

Worker C: RL-109 after RL-100; RL-110 after RL-097/099; RL-111 after RL-092/098; RL-112 after RL-089/092/099.

Wave 7 integration gate:
RL-101..RL-112.

### Wave 8 — validation

RL-113 consumes the complete public journey surface.
RL-114 validates responsive/accessibility behavior.
RL-115 verifies every architecture capability has a discoverable UX path.
RL-116 cross-checks journey states against SLO instrumentation.
RL-117 validates the public demo deployment.
RL-118 validates production deployment.

RL-113 + RL-114 + RL-115 + RL-116 + RL-117 -> RL-118.