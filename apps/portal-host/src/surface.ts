/**
 * The hosted surfaces (RL-089): mounting apps/web and apps/admin into the
 * portal host.
 *
 * The surfaces are pure view+command layers (RL-060/061): they render
 * through the typed @roamlink/app-kit client and hold NO authority. The host
 * binds each render to the requester's session (the httpOnly cookie token ->
 * in-process transport -> the REAL API service), so every page read and
 * every command flows through the same authenticated /v1 boundary an
 * external API client would use - the host adds no surface authority and
 * invents no state (fail-closed rendering stays inside the apps).
 *
 * The page tables come from the apps themselves (WEB_PAGE_ROUTES /
 * ADMIN_PAGE_ROUTES): the host resolves a URL to a (page, params) request
 * and never hard-codes surface navigation.
 */
import {
  htmlDocument,
  el,
  fragment,
  text,
  pageShell,
  RoamLinkApiClient,
  type HtmlFragment,
  type HttpRequest,
  type RequestIdGenerator,
} from "@roamlink/app-kit";
import { CustomerWebApp, WEB_PAGE_ROUTES, type WebPageName } from "@roamlink/web";
import { AdminConsoleApp, ADMIN_PAGE_ROUTES, type AdminPageName } from "@roamlink/admin";
import type { ApiService } from "@roamlink/api-service";

import { createSessionTransport } from "./session.js";
import type { DemoAccountView } from "./demo-accounts.js";

// ---------------------------------------------------------------------------
// URL -> page-request resolution (the apps' own route tables)
// ---------------------------------------------------------------------------

export interface ResolvedPage<P extends string> {
  readonly page: P;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Matches `pathname` against one of the app's templates (exact first, then
 * the single-parameter templates). The route tables are the APPS' property;
 * this resolver only translates a URL into the app's own page request.
 */
function resolveAgainst<P extends string>(
  routes: Readonly<Record<P, string>>,
  pathname: string,
): ResolvedPage<P> | undefined {
  const entries = Object.entries(routes) as unknown as readonly (readonly [P, string])[];
  for (const [name, template] of entries) {
    if (template === pathname) return { page: name, params: {} };
  }
  for (const [name, template] of entries) {
    const open = template.indexOf("{");
    if (open === -1) continue;
    const prefix = template.slice(0, open);
    const placeholder = template.slice(open); // e.g. "{deviceId}"
    if (!/^\{\w+\}$/.test(placeholder)) continue; // single-param templates only
    if (!pathname.startsWith(prefix)) continue;
    const value = pathname.slice(prefix.length);
    if (value.length === 0 || value.includes("/")) continue;
    return { page: name, params: { [placeholder.slice(1, -1)]: value } };
  }
  return undefined;
}

/** Resolves a customer-surface URL (the web app's own route table). */
export function resolveWebPage(pathname: string): ResolvedPage<WebPageName> | undefined {
  return resolveAgainst(WEB_PAGE_ROUTES, pathname);
}

/** Resolves an admin-console URL (paths are mounted under the /admin prefix). */
export function resolveAdminPage(pathname: string): ResolvedPage<AdminPageName> | undefined {
  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return undefined;
  const stripped = pathname.replace(/^\/admin/, "");
  const normalized = stripped.length === 0 ? "/" : stripped;
  return resolveAgainst(ADMIN_PAGE_ROUTES, normalized);
}

// ---------------------------------------------------------------------------
// The session-bound client factory (the ONLY place a surface gets a client)
// ---------------------------------------------------------------------------

/** Host request-id generator: canonical lowercase UUIDs, fresh per request. */
const HOST_IDS: RequestIdGenerator = { next: () => crypto.randomUUID() };

export type SurfaceApi = Pick<ApiService, "handle">;

export interface SurfaceClient {
  readonly client: RoamLinkApiClient;
  readonly actorId: string;
  readonly tenantId: string;
}

/**
 * Resolves the session behind the presented token into a surface client:
 * the principal read is a REAL /v1/users/me through the real API boundary;
 * any failure (unknown/expired/revoked token) surfaces to the caller so the
 * host can re-authenticate instead of rendering half a page.
 */
export async function resolveSurfaceClient(
  api: SurfaceApi,
  token: string,
): Promise<SurfaceClient> {
  const principalRequest: HttpRequest = {
    method: "GET",
    path: "/v1/users/me",
    headers: { authorization: `Bearer ${token}` },
  };
  const response = await api.handle(principalRequest);
  if (response.status !== 200 || response.body === undefined) {
    throw new SessionResolutionError(`the presented session was rejected (${response.status})`);
  }
  const parsed: unknown = JSON.parse(response.body);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>)["actorId"] !== "string" ||
    typeof (parsed as Record<string, unknown>)["tenantId"] !== "string"
  ) {
    throw new SessionResolutionError("the principal view was not the contracted session resource");
  }
  const principal = parsed as { readonly actorId: string; readonly tenantId: string };
  return {
    actorId: principal.actorId,
    tenantId: principal.tenantId,
    client: new RoamLinkApiClient({
      transport: createSessionTransport(api, token),
      actor: { actorId: principal.actorId, tenantId: principal.tenantId },
      ids: HOST_IDS,
    }),
  };
}

/** The session behind a surface request could not be resolved. */
export class SessionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionResolutionError";
  }
}

// ---------------------------------------------------------------------------
// Page rendering (thin: the apps render; the host only binds + translates)
// ---------------------------------------------------------------------------

/** Renders one customer web page into the full HTML document. */
export async function renderCustomerDocument(
  api: SurfaceApi,
  token: string,
  pathname: string,
): Promise<string> {
  const resolved = resolveWebPage(pathname);
  if (resolved === undefined) throw new SurfaceNotFoundError(pathname);
  const { client } = await resolveSurfaceClient(api, token);
  const app = new CustomerWebApp({ client });
  return app.renderDocument({ page: resolved.page, params: resolved.params });
}

/** Renders one admin console page into the full HTML document. */
export async function renderAdminDocument(
  api: SurfaceApi,
  token: string,
  pathname: string,
): Promise<string> {
  const resolved = resolveAdminPage(pathname);
  if (resolved === undefined) throw new SurfaceNotFoundError(pathname);
  const { client } = await resolveSurfaceClient(api, token);
  const app = new AdminConsoleApp({ client });
  return app.renderDocument({ page: resolved.page });
}

/** The requested surface path is not a page of the mounted app. */
export class SurfaceNotFoundError extends Error {
  constructor(pathname: string) {
    super(`no surface page exists at "${pathname}"`);
    this.name = "SurfaceNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// The host login page (the session layer's own document)
// ---------------------------------------------------------------------------

/**
 * The quick-action styles for the demo accounts section of the login page
 * (additive CSS appended after the app-kit base styles; no other page uses
 * these classes, so the blast radius is the login document alone).
 */
const DEMO_LOGIN_STYLES = `
.demo-accounts { display: grid; gap: 0.6rem; margin: 0.5rem 0 1rem; }
.demo-account-form { margin: 0; }
.demo-account-button {
  display: block; width: 100%; text-align: left; cursor: pointer;
  font: inherit; color: inherit; background: #fff;
  border: 1px solid #e2e2e2; border-radius: 8px; padding: 0.7rem 0.9rem;
}
.demo-account-button:hover { border-color: #b7e4c0; background: #f7fcf8; }
.demo-account-button:focus-visible { outline: 2px solid #14532d; outline-offset: 2px; }
.demo-account-name { display: block; font-weight: 600; }
.demo-account-summary { display: block; font-size: 0.85rem; color: #555; margin-top: 0.15rem; }
.demo-account-email { display: block; font-size: 0.8rem; color: #777; margin-top: 0.25rem; }
.login-divider {
  display: flex; align-items: center; gap: 0.75rem; color: #999; font-size: 0.85rem;
  margin: 1.25rem 0 0.5rem;
}
.login-divider::before, .login-divider::after {
  content: ""; flex: 1; border-top: 1px solid #e2e2e2;
}
`.trim();

/** Renders one demo persona's one-click sign-in form (a plain POST of the
 *  persona's public credentials - the same /auth/session binding the manual
 *  form uses, no parallel auth path, no client-side script). */
function demoAccountForm(account: DemoAccountView): HtmlFragment {
  return el(
    "form",
    {
      method: "POST",
      action: "/auth/session",
      class: "demo-account-form",
      "data-demo-account": account.key,
    },
    fragment(
      el("input", { type: "hidden", name: "email", value: account.email }),
      el("input", { type: "hidden", name: "password", value: account.password }),
      el(
        "button",
        { type: "submit", class: "demo-account-button" },
        fragment(
          el("span", { class: "demo-account-name" }, text(account.displayName)),
          el("span", { class: "demo-account-summary" }, text(account.summary)),
          el("span", { class: "demo-account-email" }, text(account.email)),
        ),
      ),
    ),
  );
}

/** The demo accounts section of the login document (quick action logins). */
function demoAccountsSection(accounts: readonly DemoAccountView[]): HtmlFragment {
  const [first] = accounts;
  const password = first?.password ?? "";
  return fragment(
    el("h2", {}, text("Demo accounts")),
    el(
      "p",
      { class: "muted" },
      text(
        "This is the public demo environment: one-click sign-in with a demo persona, or use the shared public password below with any demo email.",
      ),
    ),
    el(
      "div",
      { class: "demo-accounts", "data-demo-accounts": "true" },
      fragment(...accounts.map((account) => demoAccountForm(account))),
    ),
    el(
      "p",
      { class: "muted" },
      fragment(
        text("Shared demo password (a public fixture, not a secret): "),
        el("code", {}, text(password)),
      ),
    ),
  );
}

/** Renders the host login document. `error` is the API's typed message (safe by contract).
 *  `demoAccounts` (the demo environment's public roster, when enabled) renders
 *  the quick action sign-in forms above the manual credential form. */
export function renderLoginDocument(
  error?: string,
  demoAccounts?: readonly DemoAccountView[],
): string {
  const hasDemoAccounts = demoAccounts !== undefined && demoAccounts.length > 0;
  return htmlDocument(
    "RoamLink - Sign in",
    fragment(
      pageShell({
        appTitle: "RoamLink",
        navLinks: [],
        main: fragment(
          el("h2", {}, text("Sign in")),
          el(
            "p",
            { class: "muted" },
            text(
              "The RoamLink customer portal. Your session is an httpOnly cookie bound to your authenticated API session.",
            ),
          ),
          error === undefined ? fragment() : el("p", { class: "error", role: "alert" }, text(error)),
          hasDemoAccounts ? demoAccountsSection(demoAccounts) : fragment(),
          hasDemoAccounts
            ? el("p", { class: "login-divider", "aria-hidden": "true" }, text("or sign in with credentials"))
            : fragment(),
          el(
            "form",
            { method: "POST", action: "/auth/session" },
            el(
              "label",
              { for: "email" },
              text("Email"),
              el("input", {
                id: "email",
                name: "email",
                type: "email",
                required: "required",
                autocomplete: "username",
              }),
            ),
            el(
              "label",
              { for: "password" },
              text("Password"),
              el("input", {
                id: "password",
                name: "password",
                type: "password",
                required: "required",
                autocomplete: "current-password",
              }),
            ),
            el("button", { type: "submit" }, text("Sign in")),
          ),
        ),
        footerNote:
          "RoamLink hosted runtime (RL-089): the host composes the surfaces and the authenticated API; it holds no authority of its own.",
      }),
    ),
    { styles: [DEMO_LOGIN_STYLES] },
  ).html;
}
