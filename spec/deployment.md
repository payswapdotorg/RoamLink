# RoamLink Deployment Architecture

**Status:** IMPLEMENTATION PLAN  
**Target:** low-cost/free-tier development and early demonstration deployment.

## 1. Current deployment state

RoamLink is **not currently deployed as a complete interactive product**.

apps/web, apps/admin and apps/mobile are workspace packages. The customer web package explicitly requires a host. There is no current production web host, no real SQL migration set, and persistence still uses the deterministic in-memory adapter. DATABASE_URL and REDIS_URL are placeholders rather than configured infrastructure.

The current release gates prove deterministic architectural behavior; they do not constitute a hosted production deployment.

## 2. Target early deployment

### Web / API host

**Vercel**

Use one Next.js host application initially:

- customer portal;
- admin console;
- API routes / BFF;
- webhook endpoint;
- health/readiness endpoint;
- scheduled maintenance/reconciliation entry points.

Keep apps/web and apps/admin as presentation packages. The host composes them.

Vercel currently offers a $0 Hobby plan with automatic CI/CD and CDN capabilities, but its current terms restrict Hobby use to personal/non-commercial use. It is therefore appropriate for the public demo / non-commercial validation environment; commercial operation should move to a paid Vercel plan or another host before launch.

### Primary database

**Neon Postgres Free Plan**

Use PostgreSQL as the production persistence driver behind the existing @roamlink/persistence ports.

Required:

- real migrations under infra/migrations;
- connection pooling/serverless-safe driver;
- transaction semantics matching the tested UnitOfWork contract;
- optimistic concurrency;
- durable inbox/outbox;
- backup/export path.

Neon currently documents a free plan with scale-to-zero and per-project resource limits suitable for early deployments.

### Short-lived coordination

**Upstash Redis Free**

Use Redis only for:

- rate limiting;
- hot cache;
- short TTL coordination;
- ephemeral session acceleration;
- abuse protection.

Do NOT make Redis the source of truth for orders, payments, intents, projections, audit, outbox or inbox.

### Durable HTTP jobs

**Upstash QStash Free**

Use QStash for asynchronous work that is safe to retry:

- reconciliation triggers;
- webhook retry orchestration;
- projection refresh jobs;
- notification delivery;
- cleanup tasks.

The current free tier provides 1,000 messages/day, 50 GB/month bandwidth, 1 MB message size and DLQ support.

Core durability still lives in PostgreSQL; QStash is a delivery mechanism.

### Object storage

**Cloudflare R2**

Use R2 for:

- support attachments;
- diagnostic exports;
- user-downloadable reports;
- large non-relational evidence artifacts;
- encrypted application-level backup/export artifacts.

Do not move relational authority into object storage.

Current R2 pricing includes 10 GB-month storage, 1M Class A operations and 10M Class B operations per month in the free tier, with free egress.

## 3. Deployment topology

                         +-----------------------+
                         |       User Web        |
                         | desktop / mobile web  |
                         +-----------+-----------+
                                     |
                                     | HTTPS
                                     v
                         +-----------------------+
                         |       Vercel          |
                         |   RoamLink Web Host   |
                         |                       |
                         | customer + admin UI   |
                         | API / BFF              |
                         | webhook ingress        |
                         | health/readiness       |
                         | cron endpoints         |
                         +----+----------+--------+
                              |          |
                         SQL  |          | async
                              v          v
                     +------------+  +------------+
                     |    Neon    |  |  QStash    |
                     | PostgreSQL|  |  + Redis   |
                     +------------+  +------+-----+
                                            |
                           +----------------+----------------+
                           |                                 |
                           v                                 v
                  +----------------+                 +---------------+
                  |     ADCOS      |                 |   Cloudflare  |
                  | Developer API  |                 |      R2       |
                  +----------------+                 +---------------+

## 4. Runtime boundaries

Vercel request handlers may compose the existing services, but they must not absorb domain authority into route handlers.

Use:

HTTP -> application command/query -> domain/integration -> persistence

not:

HTTP -> ad hoc database mutation

Webhook:

ADCOS -> Vercel webhook route -> durable inbox -> QStash -> projection/reconciliation

## 5. Free-tier operating constraints

Design specifically around the limits:

- Vercel Hobby cannot be treated as commercial production.
- Hobby scheduled jobs have coarse cadence; current Vercel documentation says Hobby cron execution is once per day, so higher-frequency reconciliation must be event-driven through QStash or another paid/runtime path.
- Neon should use scale-to-zero and conservative compute.
- Upstash Redis must remain a bounded accelerator.
- QStash must remain below its daily message budget.
- R2 should hold only large-object data, not frequently-mutated relational state.

## 6. Environment separation

Create:

- local;
- preview;
- demo;
- production.

Neon should provide isolated branches where practical.

Never put production ADCOS credentials in preview environments.

Use different database, Redis, QStash, R2, ADCOS credentials and webhook secrets per environment.

## 7. Required deployment checks

Before demo deployment:

- real database migration passes from empty state;
- backup/restore passes;
- health/readiness is real, not fake;
- webhook signatures are configured;
- ADCOS compatibility gate runs against the configured endpoint;
- no in-memory adapter is used for production;
- stuck outbox recovery is implemented;
- inbox backlog processing advances beyond one batch;
- R2 uploads use scoped credentials;
- Redis is optional for correctness;
- job retry is idempotent;
- synthetic smoke journey is green.

## 8. Provider portability

The deployment interfaces must remain provider-neutral.

All providers sit behind ports:

- PostgreSQL adapter;
- Redis adapter;
- object storage adapter;
- async delivery adapter;
- web hosting/runtime adapter.

Replacing Neon, Upstash, R2 or Vercel must not require changes to domain authority.

## 9. Commercial transition

When the product becomes commercial:

- replace Vercel Hobby with a commercially permitted plan/host;
- upgrade database capacity;
- establish production backups/PITR appropriate to the risk;
- add stronger uptime/alerting;
- add multi-process recovery tests;
- move from free job budgets to measured workload capacity;
- add production incident procedures.
