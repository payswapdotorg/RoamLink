# Free-tier operating constraints (RL-099)

`spec/deployment.md` §5 rendered as OPERATIONAL GUIDANCE. These limits
are documented facts about provider plans; RoamLink NEVER encodes a
provider quota into correctness logic — a provider limit that can threaten
correctness is a BLOCKER surfaced to the operator, not a branch (handoff
§12 stop-rule). Verify current published limits at deployment time
(RL-100+); this file is guidance, not a quota contract.

| Provider (role) | Documented early-plan behavior | Operating guidance for RoamLink |
|---|---|---|
| **Vercel** (hosting/runtime) | Hobby plan: $0, personal/non-commercial terms; scheduled (cron) jobs limited to coarse cadence — documented as once per day | Treat Hobby as demo/non-commercial ONLY; commercial launch moves to a commercially permitted plan/host (deployment.md §9). Do NOT schedule higher-frequency work on Hobby cron. |
| **Neon** (durable PostgreSQL) | Free plan with scale-to-zero; computes autosuspend; per-project resource limits | Use scale-to-zero + conservative compute; pooled endpoints for serverless request paths; migrations/long workers on the direct endpoint. Expect cold starts; alert on probe failures, not on autosuspension. |
| **Upstash Redis** (bounded accelerator) | Free tier sized for small volumes (documented per-provider command/bandwidth limits) | Redis MUST remain a bounded accelerator: every key TTL-bounded (the port enforces it), values size-bounded, no durable business state. Higher-frequency rate limiting stays within plan limits or becomes a paid plan — never a correctness dependency. |
| **Upstash QStash** (async delivery) | Free tier documents ~1,000 messages/day, 1 MB message limit, DLQ support | Keep scheduling EVENT-DRIVEN: durable jobs (Postgres ledger) + QStash delivery replaces high-frequency cron. Payloads stay well under the message cap (adapter bound: 1 MiB). Watch the daily budget; budget pressure is an operator signal, not a code branch. DLQ review is part of the runbook. |
| **Cloudflare R2** (large artifacts) | Free tier documents ~10 GB-month storage, ~1M Class A / ~10M Class B ops/month, free egress | R2 holds ONLY large, largely-immutable artifacts (attachments/exports/backups). Frequently-mutated relational state stays in PostgreSQL. Content-addressed keys keep re-uploads idempotent. Scoped per-bucket credentials. |

## The two structural consequences

1. **Hobby cron cadence -> event-driven reconciliation.** Vercel Hobby
   crons run at most once per day, so higher-frequency reconciliation is
   NOT scheduled — it is event-driven through QStash deliveries
   (RL-097's durable-jobs flow). The `vercel.json` cron is a coarse daily
   maintenance trigger only (daily reconciliation sweep/cleanup), with
   everything finer-grained driven by durable job events.
2. **Optional-by-construction accelerators.** Redis and QStash adapters
   are optional per environment (missing env keys = non-accelerated /
   non-delivered path). This keeps correctness independent of provider
   availability AND lets early environments run with fewer providers.
