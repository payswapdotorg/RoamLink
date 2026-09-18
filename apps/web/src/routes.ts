/**
 * The customer web app's own page routes (RL-060 + RL-083).
 *
 * These are APP pages, not API resources: they describe where the customer
 * surface renders, and every one of them is fed exclusively by
 * {@link @roamlink/app-kit!RoamLinkApiClient} reads + mutation flows. The
 * route table exists so a host (a service with a session layer) can mount the
 * rendered pages without knowing their internals.
 *
 * RL-083 navigation note (spec/ux-architecture.md §3): existing internal
 * routes stay stable and UI labels may be more human than route names —
 * the Goals nav destination renders the ExperienceIntent surface
 * (`/intents`), Activity renders the automation/notifications narrative,
 * Plans & Billing renders `/commerce`. `home` owns `/` (the customer lands
 * on the Home hero); the legacy aggregate view moved from `/` to
 * `/overview` (still fully reachable, linked from the Home + Connectivity
 * surfaces).
 */
export const WEB_PAGE_ROUTES = Object.freeze({
  home: "/",
  onboarding: "/onboarding",
  overview: "/overview",
  connectivity: "/connectivity",
  devices: "/devices",
  device: "/devices/{deviceId}",
  intents: "/intents",
  intent: "/intents/{intentId}",
  commerce: "/commerce",
  order: "/orders/{orderId}",
  activity: "/activity",
  notifications: "/notifications",
  support: "/support",
  case: "/support/{caseId}",
  more: "/more",
  settings: "/settings",
} as const);

export type WebPageName = keyof typeof WEB_PAGE_ROUTES;

export function pagePath(name: WebPageName, params: Readonly<Record<string, string>> = {}): string {
  const template: string = WEB_PAGE_ROUTES[name];
  return template.replace(/\{(\w+)\}/g, (_match, param: string) => {
    const value = params[param];
    if (value === undefined || value.length === 0) {
      throw new Error(`web page route '${String(name)}' is missing parameter '${param}'`);
    }
    return encodeURIComponent(value);
  });
}
