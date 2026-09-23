/**
 * The admin console's page routes (RL-061).
 *
 * Console pages over the SAME public application API the customer app uses
 * (spec/repository-layout.md: services compose domain modules; the console
 * is a view + command surface over them - it holds no parallel authority).
 */
export const ADMIN_PAGE_ROUTES = Object.freeze({
  tenants: "/",
  audit: "/audit",
  reconciliation: "/reconciliation",
  projectionHealth: "/projection-health",
  supportTriage: "/support",
  // PA-010 (RL-115-F6): the §13 "integration/compatibility health" console
  // surface over the same public application API the customer app consumes.
  integrationHealth: "/integration-health",
} as const);

export type AdminPageName = keyof typeof ADMIN_PAGE_ROUTES;

export function adminPagePath(name: AdminPageName): string {
  return ADMIN_PAGE_ROUTES[name];
}

/**
 * The HOST's operator SLO dashboard route (RL-109) — NOT a console page.
 *
 * The §11 dashboard lives host-side (apps/portal-host `/ops/slo`) because the
 * console's `/v1` read routes answer the honest 501 READ_MODEL_NOT_COMPOSED
 * for it on the real runtime — the console must not compose that read model
 * (see apps/portal-host/src/slo.ts for the architecture decision). This
 * constant exists so the console's navigation can point at the dashboard
 * without inventing a console surface for it (PA-009, closes RL-115-F2):
 * the entry is a plain link, and the target keeps its own fail-closed
 * session + `org:read` permission gate — the same permission the console's
 * read surfaces map to (SURFACE_READ_PERMISSIONS in ./app.ts).
 */
export const OPS_SLO_DASHBOARD_PATH = "/ops/slo";
