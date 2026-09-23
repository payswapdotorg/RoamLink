/**
 * The hosted surfaces (RL-089): URL resolution against the apps' OWN route
 * tables and the host login document.
 */
import { describe, expect, it } from "vitest";

import { renderLoginDocument, resolveAdminPage, resolveWebPage } from "../src/index.js";

describe("resolveWebPage (the web app's own route table)", () => {
  it("matches the exact templates", () => {
    // RL-083 (PR #19): `home` owns `/` (the customer lands on the Home hero);
    // the legacy aggregate view moved to `/overview`; onboarding owns
    // `/onboarding`. This test asserts the CURRENT frozen route table.
    expect(resolveWebPage("/")?.page).toBe("home");
    expect(resolveWebPage("/overview")?.page).toBe("overview");
    expect(resolveWebPage("/onboarding")?.page).toBe("onboarding");
    expect(resolveWebPage("/connectivity")?.page).toBe("connectivity");
    expect(resolveWebPage("/devices")?.page).toBe("devices");
    expect(resolveWebPage("/intents")?.page).toBe("intents");
    expect(resolveWebPage("/commerce")?.page).toBe("commerce");
    expect(resolveWebPage("/notifications")?.page).toBe("notifications");
    expect(resolveWebPage("/support")?.page).toBe("support");
  });

  it("matches the single-parameter templates and extracts the parameter", () => {
    const device = resolveWebPage("/devices/dev-123");
    expect(device?.page).toBe("device");
    expect(device?.params["deviceId"]).toBe("dev-123");
    const intent = resolveWebPage("/intents/int-9");
    expect(intent?.page).toBe("intent");
    expect(intent?.params["intentId"]).toBe("int-9");
    const order = resolveWebPage("/orders/ord-7");
    expect(order?.page).toBe("order");
    expect(order?.params["orderId"]).toBe("ord-7");
    const supportCase = resolveWebPage("/support/case-42");
    expect(supportCase?.page).toBe("case");
    expect(supportCase?.params["caseId"]).toBe("case-42");
  });

  it("answers undefined for anything that is not a page (honest 404, never a guess)", () => {
    expect(resolveWebPage("/nope")).toBeUndefined();
    expect(resolveWebPage("/devices/")).toBeUndefined();
    expect(resolveWebPage("/devices/a/b")).toBeUndefined();
    expect(resolveWebPage("/orders")).toBeUndefined();
    expect(resolveWebPage("//")).toBeUndefined();
  });
});

describe("resolveAdminPage (the console's own route table under /admin)", () => {
  it("matches the console templates", () => {
    expect(resolveAdminPage("/admin")?.page).toBe("tenants");
    expect(resolveAdminPage("/admin/")?.page).toBe("tenants");
    expect(resolveAdminPage("/admin/audit")?.page).toBe("audit");
    expect(resolveAdminPage("/admin/reconciliation")?.page).toBe("reconciliation");
    expect(resolveAdminPage("/admin/projection-health")?.page).toBe("projectionHealth");
    expect(resolveAdminPage("/admin/support")?.page).toBe("supportTriage");
    // PA-010 (RL-115-F6): the integration-health console surface resolves
    // through the console's own route table under the /admin mount.
    expect(resolveAdminPage("/admin/integration-health")?.page).toBe("integrationHealth");
  });

  it("answers undefined outside the /admin mount (the customer root is NOT a console page)", () => {
    expect(resolveAdminPage("/")).toBeUndefined();
    expect(resolveAdminPage("/audit")).toBeUndefined();
    expect(resolveAdminPage("/admin/nope")).toBeUndefined();
  });
});

describe("the host login document", () => {
  it("renders the session-layer form (POST to the cookie-binding route)", () => {
    const html = renderLoginDocument();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('action="/auth/session"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("role=\"alert\"");
  });

  it("renders a typed failure message with role=alert (the API's message, safe by contract)", () => {
    const html = renderLoginDocument("authentication failed (credentials rejected)");
    expect(html).toContain("authentication failed (credentials rejected)");
    expect(html).toContain('role="alert"');
  });
});
