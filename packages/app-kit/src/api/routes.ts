/**
 * The API route table (RL-060/061 application contract).
 *
 * The `/v1/...` templates below are the typed client's entire URL surface.
 * The spec-listed representative resources (spec/api.md) must all appear
 * here; additional routes are additive (the contract is additive-change
 * tolerant, RL-LOCK-017). A conformance test parses spec/api.md and fails
 * when a spec-listed resource disappears from this table.
 */
export const API_ROUTE_TEMPLATES = Object.freeze({
  actorSession: "/v1/users/me",
  user: "/v1/users/{userId}",
  devices: "/v1/devices",
  device: "/v1/devices/{deviceId}",
  deviceUpdate: "/v1/devices/{deviceId}/update",
  deviceRetire: "/v1/devices/{deviceId}/retire",
  experienceIntents: "/v1/experience-intents",
  experienceIntent: "/v1/experience-intents/{intentId}",
  experienceIntentVersions: "/v1/experience-intents/{intentId}/versions",
  experienceIntentActivate: "/v1/experience-intents/{intentId}/activate",
  products: "/v1/products",
  orders: "/v1/orders",
  order: "/v1/orders/{orderId}",
  orderCancel: "/v1/orders/{orderId}/cancel",
  orderComplete: "/v1/orders/{orderId}/complete",
  subscriptions: "/v1/subscriptions",
  payments: "/v1/payments",
  connectivity: "/v1/connectivity",
  notifications: "/v1/notifications",
  notificationRead: "/v1/notifications/{notificationId}/read",
  organizations: "/v1/organizations",
  organizationSuspend: "/v1/organizations/{tenantId}/suspend",
  organizationReactivate: "/v1/organizations/{tenantId}/reactivate",
  auditEvents: "/v1/audit-events",
  reconciliationJobs: "/v1/reconciliation-jobs",
  projectionHealth: "/v1/projection-health",
  supportCases: "/v1/support-cases",
  supportCaseTransitions: "/v1/support-cases/{caseId}/transitions",
  command: "/v1/commands/{commandId}",
} as const);

export type ApiRouteName = keyof typeof API_ROUTE_TEMPLATES;

/** Fills a route template's `{param}` segments. */
export function route(name: ApiRouteName, params: Readonly<Record<string, string>> = {}): string {
  const template: string = API_ROUTE_TEMPLATES[name];
  return template.replace(/\{(\w+)\}/g, (_match, param: string) => {
    const value = params[param];
    if (value === undefined || value.length === 0) {
      throw new Error(
        `route '${String(name)}' is missing the required path parameter '${param}'`,
      );
    }
    return encodeURIComponent(value);
  });
}
