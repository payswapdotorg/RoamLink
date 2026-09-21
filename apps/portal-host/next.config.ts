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
  // The workspace's typecheck authority is `pnpm typecheck` (strict
  // tsc --noEmit over the same tsconfig, enforced by the release gates);
  // the build's internal TS pass is redundant AND would try to
  // npm-install @types/react inside the pnpm workspace (unsupported
  // protocol) — so it is skipped here, never weakened elsewhere.
  typescript: { ignoreBuildErrors: true },
  // The workspace's TS sources use the TypeScript-ESM import convention
  // (`./module.js` naming the sibling `module.ts`). Neither of Next's
  // bundlers applies the tsc `.js` -> `.ts` mapping by default, so the
  // webpack build maps it explicitly (extensionAlias; the standard
  // interop). Builds run with `next build --webpack`.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
