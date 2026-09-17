
## §11 intent-satisfaction measurement point (additive RL-052 wiring)

`src/decision/intent-satisfaction.ts` maps the RL-013 read model onto the
§11 SLO "intent satisfaction rate" with a PURE function: a decision whose
derived status is `experience_supported` is a SATISFIED intent;
`experience_degraded`/`experience_unresolved` are NOT satisfied; and
`experience_pending`/`experience_closed` are NOT MEASURABLE (null — recording
either would fabricate a denominator). No new authority: the mapping derives
from the closed derived-status vocabulary, and the caller (the composed
harness or service) owns the recording instant and the observability
recorder the outcome is handed to.
