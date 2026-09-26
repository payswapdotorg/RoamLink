# RoamLink Deployment Architecture

Status: CURRENT IMPLEMENTATION + NEXT LIVE-RUNTIME PHASE

## 1. Current deployment state

RoamLink has a real hosted demo.

Current accepted/live-demo history:
- Vercel Hobby portal/runtime;
- Neon Free PostgreSQL;
- webhook signing configured;
- provider adapters for Redis, QStash and R2 implemented;
- real-wire verification completed for Neon, Redis, QStash and R2 across PA-011/012/013/017.

Important qualification:
- the formal RL-118 acceptance record predates PA-018/PA-019;
- current main therefore requires a fresh current-SHA deployment acceptance before the current tree is considered fully accepted;
- ADCOS production credentials remain an external configuration step;
- the current live demo may keep Redis/R2/QStash optional or disabled; actual state must be recorded by the current acceptance run.

## 2. Target early validation stack

- Vercel Hobby — hosted portal/runtime, personal/non-commercial demo only.
- Neon Free PostgreSQL — durable source of truth.
- Upstash Redis Free — ephemeral rate limiting/coordination.
- Upstash QStash Free — asynchronous delivery.
- Cloudflare R2 — object storage / backup artifacts.
- ADCOS public Developer API — connectivity authority.

The providers are adapters, not domain authorities.

## 3. Runtime topology

User
 ↓
Vercel Next.js host
 ├── customer portal
 ├── admin console
 ├── API/BFF
 ├── webhook ingress
 ├── /healthz
 ├── /readyz
 └── bounded worker trigger
        │
        ├── Neon PostgreSQL
        ├── Upstash Redis
        ├── Upstash QStash
        └── Cloudflare R2

QStash
 ↓
authenticated bounded worker endpoint
 ↓
services/workers execution seam
 ↓
Neon durable command/outbox state

ADCOS
 ↓
webhook ingress
 ↓
durable inbox
 ↓
QStash / worker execution
 ↓
projection/reconciliation

## 4. Critical free-tier constraint

Do not run an unbounded long-lived worker inside a Vercel request handler.

For the demo, use a bounded worker trigger over the existing worker composition:

durable outbox
→ QStash
→ authenticated bounded worker endpoint
→ one bounded execution batch
→ durable execution result

The long-running services/workers host remains the preferred production composition; the bounded trigger is the free-tier-compatible demo composition.

## 5. Provider roles

PostgreSQL:
- all durable business state;
- command ledger;
- inbox/outbox;
- read-model state where applicable.

Redis:
- rate limiting;
- short-lived cache/coordination only.

QStash:
- retryable asynchronous delivery;
- reconciliation triggers;
- worker kicks.

R2:
- objects/attachments/backups only.

Vercel:
- hosting/runtime only.

ADCOS:
- canonical connectivity authority.

## 6. Current live-runtime gaps that deployment must close

1. command execution is not yet advancing every accepted command in the demo;
2. notification read source is not bound;
3. product/order/subscription read sources are not bound;
4. enterprise workspace read is not composed;
5. integration-health read source is not bound;
6. audit/projection-health read sources are not bound;
7. eSIM mutation routes are not present in the live API mutation table;
8. enterprise connector mutation route is not present in the live API mutation table.

## 7. Deployment acceptance sequence

1. migrate Neon;
2. verify migration manifest;
3. configure current webhook signing keys;
4. configure bounded worker trigger;
5. configure QStash endpoint/signing keys;
6. optionally configure Redis;
7. optionally configure R2;
8. configure ADCOS production credentials;
9. deploy current main;
10. run health/readiness;
11. run smoke;
12. run browser journeys;
13. run demo acceptance;
14. run rollback acceptance;
15. record deployed SHA + provider states + named skips.

## 8. Free-tier facts to verify at deployment time

Do not hard-code quotas into correctness.

The current official pages used for the handoff are:
- Vercel Hobby terms;
- Neon Free pricing;
- Upstash Redis Free pricing;
- Upstash QStash Free pricing;
- Cloudflare R2 pricing.

Provider limits are current-plan facts and must be rechecked by the Tech Lead before a commercial deployment.

## 9. Commercial transition

Before commercial launch:
- move off Vercel Hobby to a commercially permitted plan/host;
- scale Neon appropriately;
- establish production backup/PITR;
- upgrade job capacity;
- add stronger alerting;
- add continuous worker capacity;
- retain provider-neutral ports.
