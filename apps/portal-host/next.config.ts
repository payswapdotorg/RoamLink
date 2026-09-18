import type { NextConfig } from "next";

/**
 * The RoamLink hosted runtime (RL-089).
 *
 * The workspace packages are TS-source packages (exports point at
 * `./src/index.ts`), so every `@roamlink/*` module in the host's import
 * graph is transpiled by Next. Vercel is ONLY the runtime/host
 * (spec/adr/0003): nothing here is provider-locked — the same host runs on
 * any Node 22+ runtime with a PostgreSQL DATABASE_URL.
 */
const ROAMLINK_PACKAGES = [
  "@roamlink/admin",
  "@roamlink/api-service",
  "@roamlink/app-kit",
  "@roamlink/auth",
  "@roamlink/commerce-connectivity",
  "@roamlink/contracts",
  "@roamlink/domain-commerce",
  "@roamlink/domain-experience",
  "@roamlink/integration",
  "@roamlink/intent-compiler",
  "@roamlink/notifications",
  "@roamlink/observability",
  "@roamlink/persistence",
  "@roamlink/persistence-postgres",
  "@roamlink/projections",
  "@roamlink/reconciliation",
  "@roamlink/web",
  "@roamlink/webhook-inbox",
] as const;

const nextConfig: NextConfig = {
  transpilePackages: [...ROAMLINK_PACKAGES],
  // The pg pool and the embedded pglite engine are Node-side; never bundle
  // them into client/edge chunks.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
