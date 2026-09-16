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
} as const);

export type AdminPageName = keyof typeof ADMIN_PAGE_ROUTES;

export function adminPagePath(name: AdminPageName): string {
  return ADMIN_PAGE_ROUTES[name];
}
