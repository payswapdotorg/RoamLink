/**
 * @roamlink/portal-host - the RoamLink hosted runtime (RL-089).
 *
 * One real, deployable Next.js host that composes:
 *   - the customer surface (apps/web) under "/";
 *   - the admin console (apps/admin) under "/admin";
 *   - the authenticated API/BFF (services/api, RL-090) under "/v1";
 *   - REAL PostgreSQL persistence (packages/persistence-postgres, RL-091)
 *     with the REAL SQL migration set (infra/migrations, RL-092);
 *   - webhook ingress through the durable inbox;
 *   - the host session layer (httpOnly cookie binding) + login document;
 *   - real health/readiness endpoints.
 *
 * Layout:
 *   - `composition.ts`          the composition root (the ONLY binding site)
 *   - `readiness.ts`            the remote-API readiness probe + check (RL-100)
 *   - `scrypt-password-hasher.ts` the production KDF binding (auth port)
 *   - `http-adapter.ts`         Web Request/Response <-> app-kit translation
 *   - `session.ts`              the httpOnly cookie session layer
 *   - `surface.ts`              mounting apps/web + apps/admin
 *   - `handlers.ts`             the pure route handlers (no framework import)
 *   - `bootstrap.ts`            the memoized env-driven runtime
 *   - `demo-accounts.ts`        the demo environment's public accounts (quick action logins)
 *   - `app/`                    three-line Next.js forwarders ONLY
 *
 * Authority discipline (spec/deployment.md §4): HTTP -> application
 * command/query -> domain/integration -> persistence. Route handlers never
 * touch the database; the host never invents state (fail-closed everywhere).
 */
export * from "./composition.js";
export * from "./readiness.js";
export * from "./scrypt-password-hasher.js";
export * from "./http-adapter.js";
export * from "./session.js";
export * from "./surface.js";
export * from "./handlers.js";
export * from "./bootstrap.js";
export * from "./demo-accounts.js";
