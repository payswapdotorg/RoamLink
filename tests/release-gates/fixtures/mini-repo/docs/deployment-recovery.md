# Mini Fixture Deployment & Recovery

Cold start is verified (CS-1..CS-7). Crash recovery: crash during migration (M-5)
converges. Backup and Restore round-trip (B-1..B-4). ADCOS unreachable (D-1)
degrades honestly. Health/readiness composition: degraded is not ready.

- FINDING RL-075-F1 — fixture finding two.

## Honest gaps

- real-database semantics
- timing side channels
- denial-of-service volumes
- secrets at rest in a real backend
- webhook signing-key compromise
