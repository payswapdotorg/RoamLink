/**
 * The customer web app's own page routes (RL-060).
 *
 * These are APP pages, not API resources: they describe where the customer
 * surface renders, and every one of them is fed exclusively by
 * {@link @roamlink/app-kit!RoamLinkApiClient} reads + mutation flows. The
 * route table exists so a host (a service with a session layer) can mount the
 * rendered pages without knowing their internals.
 */
export const WEB_PAGE_ROUTES = Object.freeze({
  overview: "/",
  connectivity: "/connectivity",
  devices: "/devices",
  device: "/devices/{deviceId}",
  intents: "/intents",
  intent: "/intents/{intentId}",
  commerce: "/commerce",
  order: "/orders/{orderId}",
  notifications: "/notifications",
  support: "/support",
  case: "/support/{caseId}",
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
