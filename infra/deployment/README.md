# RoamLink deployment manifests & environment separation (RL-099)

This directory is the **hosted-deployment manifest layer** (per
`spec/repository-layout.md` hosted additions and `spec/deployment.md`).
It contains ONLY manifests, environment TEMPLATES (empty values) and
operator runbooks — never secrets, never credentials, never real
endpoints tied to an account.

```
infra/deployment/
  vercel.json                     Vercel project configuration (template)
  environments/                   one template per deployment.md §6 environment
    development.env.example
    preview.env.example
    demo.env.example
    production.env.example
  providers/                      per-provider env templates (RL-095..098)
    neon.env.example
    upstash-redis.env.example
    upstash-qstash.env.example
    cloudflare-r2.env.example
  runbooks/
    neon-provisioning.md          RL-095 operator runbook (real Neon account)
    deployment-runbook.md         RL-099 end-to-end deploy + verify runbook
  provider-wiring.md              port -> adapter -> env wiring manifest
  free-tier-constraints.md        deployment.md §5 as operational guidance
```

## Non-negotiable rules encoded here

1. **Secrets are NEVER committed.** Every `*.env.example` carries empty
   values and key-documentation only. Real values live in the target
   environment's secret store (Vercel project env vars / secret manager)
   and are entered per environment, per deployment.md §6.
2. **Provider rules (ADR-0003)**: PostgreSQL (Neon) is the durable source
   of truth; Redis is a bounded accelerator; QStash is retryable
   transport; R2 is large-object storage; Vercel is hosting/runtime only.
   Every provider sits behind a RoamLink port (see `provider-wiring.md`).
3. **Free-tier limits are operational guidance, never correctness
   logic** (`free-tier-constraints.md`, handoff §12 stop-rule).
4. Per-environment credentials are FULLY SEPARATE (database, Redis,
   QStash, R2, ADCOS, webhook secrets); production ADCOS credentials
   never enter preview.

## Deploying host

`apps/web` (plus `apps/admin` composition) is deployed by the host
composition decided at the Wave-6 integration gate; this directory stays
host-agnostic: `vercel.json` is the project configuration TEMPLATE the
deploying app adopts at RL-100+ deploy time.
