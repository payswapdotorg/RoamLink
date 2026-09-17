# Mini Fixture Threat-Model Verification

## 1. Threat matrix

| # | Threat | Verdict |
|---|--------|---------|
| 1 | forged webhooks | **VERIFIED** |
| 2 | confused deputy | **VERIFIED** |
| 3 | stale projection | **VERIFIED** |
| 4 | duplicated commands | **VERIFIED** |
| 5 | leaked credentials | **VERIFIED** |
| 6 | compromised edge | **VERIFIED** |
| 7 | malicious metadata | **VERIFIED** |
| 8 | supply chain | **VERIFIED** |
| 9 | loss/reordering | **VERIFIED** |
| 10 | privilege escalation | **VERIFIED** |

### FINDINGS

- RL-074-F1 — fixture finding one (finding for registry coverage).

## Honest gaps

- timing side channels
- denial-of-service volumes
- secrets at rest in a real backend
