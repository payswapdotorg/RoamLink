/**
 * The hosted runtime's route handlers (RL-089).
 *
 * Pure functions over Web-standard `Request`/`Response` (framework-free, no
 * Next import): each Next.js route file under `src/app/` is a three-line
 * forwarder into one of these. Composition happens once per process in
 * `bootstrap.ts`; a runtime that REFUSED to boot answers every route with
 * the honest 503 (fail-closed - the host never degrades to a fake, and the
 * readiness endpoint stays answerable even when the composition is down).
 *
 * Discipline (spec/deployment.md §4): these handlers translate transport
 * ONLY - no database access, no outcome decisions, no invented state.
 */
import { HTTP_STATUS, el, fragment, htmlDocument, pageShell, text, type ActorSessionResource, type MutationFlowResult } from "@roamlink/app-kit";
import { CompositionError } from "./composition.js";
import type { HostRuntime } from "./bootstrap.js";

import {
  MethodNotAllowedError,
  errorResponse,
  internalErrorResponse,
  translateRequest,
  translateResponse,
} from "./http-adapter.js";
import {
  clearedSessionCookie,
  sessionCookieOf,
  sessionTokenOf,
  type LoginOutcome,
} from "./session.js";
import { isAuthorizedCronRequest } from "./maintenance.js";
import {
  SessionResolutionError,
  SurfaceNotFoundError,
  renderAdminDocument,
  renderCustomerDocument,
  renderLoginDocument,
  resolveAdminPage,
  resolveSurfaceClient,
  resolveWebPage,
  type SurfaceClient,
} from "./surface.js";
import { resolveActorSession } from "./ops-surface.js";
import { opsSloSurfaceDocument } from "./ops-slo-page.js";
import { buildProductSloDashboard } from "@roamlink/observability";
import { CustomerWebApp } from "@roamlink/web";
import {
  FLOW_HANDLERS,
  FLOW_PATH_PREFIX,
  formValidationErrorOf,
  type FlowHandler,
  type FlowRunContext,
  FormValidationError,
} from "./flows.js";

// ---------------------------------------------------------------------------
// Health / readiness (spec/deployment.md: "health/readiness is real, not fake")
// ---------------------------------------------------------------------------

/** Liveness: the process is up. No dependency calls - that is readiness's job. */
export function handleHealthz(): Response {
  return new Response(JSON.stringify({ status: "alive" }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Readiness: REAL checks only - the database answers AND the migration ledger is applied. */
export async function handleReadyz(runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return new Response(
      JSON.stringify({
        // RL-100: the honest vocabulary even for the refusal answer.
        status: "not-ready:composition",
        ready: false,
        checks: [
          {
            name: "composition",
            state: "down",
            detail:
              runtime.error instanceof CompositionError
                ? runtime.error.message
                : "the host composition failed to boot (details suppressed)",
          },
        ],
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  const report = await runtime.composition.readyCheck();
  return new Response(JSON.stringify(report), {
    status: report.ready ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// The /v1 API/BFF mount (RL-090 over the REAL persistence; transport only)
// ---------------------------------------------------------------------------

export async function handleV1(request: Request, runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return errorResponse(
      503,
      "HOST_NOT_READY",
      "the hosted runtime is not ready (the composition refused to boot); no request is served",
    );
  }
  try {
    const apiRequest = await translateRequest(request);
    const apiResponse = await runtime.composition.api.handle(apiRequest);
    return translateResponse(apiResponse);
  } catch (error) {
    if (error instanceof MethodNotAllowedError) {
      return errorResponse(405, "METHOD_NOT_ALLOWED", error.message);
    }
    return internalErrorResponse();
  }
}

// ---------------------------------------------------------------------------
// The maintenance trigger (RL-107): /api/maintenance/daily - thin,
// authenticated, idempotent; a serverless route NEVER runs the sweeps as a
// long job, it kicks them (or hands them to the event-driven async path).
// ---------------------------------------------------------------------------

export async function handleMaintenanceDaily(request: Request, runtime: HostRuntime): Promise<Response> {
  // Fail-closed authentication: without CRON_SECRET configured the route
  // refuses EVERY trigger (an unauthenticated mutation surface is never
  // acceptable), and with it, only the exact Bearer match passes.
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; maintenance is unavailable");
  }
  const cronSecret = runtime.composition.maintenance.cronSecret;
  if (!isAuthorizedCronRequest(request, cronSecret)) {
    return errorResponse(
      cronSecret === undefined ? 503 : 401,
      cronSecret === undefined ? "CRON_SECRET_NOT_CONFIGURED" : "UNAUTHORIZED",
      cronSecret === undefined
        ? "the maintenance route refuses unauthenticated triggers: CRON_SECRET is not configured (fail-closed)"
        : "the maintenance trigger requires Authorization: Bearer <CRON_SECRET>",
    );
  }
  try {
    const result = await runtime.composition.maintenance.run();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return errorResponse(
      500,
      "MAINTENANCE_FAILED",
      `the maintenance trigger failed (details suppressed)${error instanceof Error ? `: ${error.name}` : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The ops SLO dashboard (RL-109): the HOST-SIDE operator surface over the
// composition's real §11 SLO bindings (see ./slo.ts for the architecture
// decision). Fail-closed rendering gate BEFORE any surface state is read.
// ---------------------------------------------------------------------------

/** The operator read permission (mirrors the console's read-surface mapping). */
const OPS_SURFACE_READ_PERMISSION = "org:read";

export async function handleOpsSloSurface(request: Request, runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; no surface is served");
  }
  const token = sessionTokenOf(request.headers.get("cookie") ?? undefined);
  if (token === undefined) return redirectTo("/login");
  let session: ActorSessionResource;
  try {
    session = await resolveActorSession(runtime.composition.api, token);
  } catch (error) {
    if (error instanceof SessionResolutionError) return redirectTo("/login");
    return internalErrorResponse();
  }
  // Fail-closed permission gate (the admin-console discipline): a denied
  // actor NEVER triggers the surface's state read — and this surface's
  // state read is the composition's own recorder evaluation.
  if (!session.permissions.includes(OPS_SURFACE_READ_PERMISSION)) {
    return htmlResponse(
      renderOpsAccessDeniedDocument(session, OPS_SURFACE_READ_PERMISSION),
    );
  }
  const { recorder, objectives } = runtime.composition.slo;
  const snapshot = buildProductSloDashboard({
    events: recorder.events,
    now: recorder.now,
    objectives,
  });
  return htmlResponse(opsSloSurfaceDocument({ snapshot }));
}

function renderOpsAccessDeniedDocument(
  session: { readonly tenantId: string; readonly scope: string; readonly role: string | null },
  permission: string,
): string {
  return htmlDocument(
    "RoamLink Ops - Access denied",
    pageShell({
      appTitle: "RoamLink Ops",
      navLinks: [{ label: "SLO dashboard", href: "/ops/slo" }],
      main: fragment(
        el(
          "div",
          {
            class: "panel error",
            "data-access-denied": "true",
            "data-required-permission": permission,
          },
          fragment(
            el("h3", {}, text("Access denied")),
            el(
              "p",
              {},
              text(
                `This ops surface requires the '${permission}' permission in tenant ${session.tenantId}.`,
              ),
            ),
            el(
              "p",
              { class: "muted" },
              text(
                `Your session: scope ${session.scope}${session.role === null ? "" : `, role ${session.role}`}. Authorization is enforced by the API; this decision is final for this session.`,
              ),
            ),
          ),
        ),
      ),
      footerNote:
        "RoamLink ops surface (RL-109): fail-closed rendering gate; denied actors never read surface state.",
    }),
  ).html;
}

function htmlResponse(document: string, status = 200): Response {
  return new Response(document, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function surfaceNotFoundDocument(pathname: string): string {
  return renderLoginDocument(`there is no page at "${pathname}" - use the navigation or sign in at /login`);
}

// ---------------------------------------------------------------------------
// The event-driven maintenance receiver (RL-110): the endpoint the QStash
// durable jobs are delivered to. Verify-before-acting lives in
// maintenance-receiver.ts; this handler adds the runtime/composition gates.
// ---------------------------------------------------------------------------

export async function handleMaintenanceReceiver(request: Request, runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; maintenance is unavailable");
  }
  const receiver = runtime.composition.maintenance.receiver;
  if (receiver === null) {
    // The honest not-configured (AR-009 discipline): the receiver-side QStash
    // signing keys are absent, so NO delivery is ever acted on - never a
    // faked trigger, never an unverified mutation surface.
    return errorResponse(
      503,
      "MAINTENANCE_RECEIVER_NOT_CONFIGURED",
      "the maintenance receiver refuses every delivery: the receiver-side QStash signing keys are not configured (fail-closed)",
    );
  }
  try {
    return await receiver.handle(request);
  } catch (error) {
    return errorResponse(
      500,
      "MAINTENANCE_RECEIVER_FAILED",
      `the maintenance receiver failed (details suppressed)${error instanceof Error ? `: ${error.name}` : ""}`,
    );
  }
}

export async function handleCustomerSurface(request: Request, runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; no surface is served");
  }
  const url = new URL(request.url);
  const pathname = url.pathname;
  // A path that is not a page of the mounted app is an honest 404 BEFORE the
  // session check (unknown pages never leak authentication state).
  if (resolveWebPage(pathname) === undefined) {
    return htmlResponse(surfaceNotFoundDocument(pathname), HTTP_STATUS.notFound);
  }
  const token = sessionTokenOf(request.headers.get("cookie") ?? undefined);
  if (token === undefined) return redirectTo("/login");
  try {
    // The app's own pages read step/goal/deviceId/notice (onboarding) and the
    // support-context params (support) from the URL's query string; the host
    // forwards the search params so the wizard and the contextual escape
    // hatch work through the GET plane (PA-018).
    return htmlResponse(
      await renderCustomerDocument(runtime.composition.api, token, pathname, {
        searchParams: url.searchParams,
      }),
    );
  } catch (error) {
    if (error instanceof SessionResolutionError) return redirectTo("/login");
    if (error instanceof SurfaceNotFoundError) {
      return htmlResponse(surfaceNotFoundDocument(pathname), HTTP_STATUS.notFound);
    }
    return internalErrorResponse();
  }
}

export async function handleAdminSurface(request: Request, runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; no surface is served");
  }
  const pathname = new URL(request.url).pathname;
  if (resolveAdminPage(pathname) === undefined) {
    return htmlResponse(surfaceNotFoundDocument(pathname), HTTP_STATUS.notFound);
  }
  const token = sessionTokenOf(request.headers.get("cookie") ?? undefined);
  if (token === undefined) return redirectTo("/login");
  try {
    return htmlResponse(await renderAdminDocument(runtime.composition.api, token, pathname));
  } catch (error) {
    if (error instanceof SessionResolutionError) return redirectTo("/login");
    if (error instanceof SurfaceNotFoundError) {
      return htmlResponse(surfaceNotFoundDocument(pathname), HTTP_STATUS.notFound);
    }
    return internalErrorResponse();
  }
}

// ---------------------------------------------------------------------------
// The /flows/* form-action POST handler (PA-018 — closes F-016-1).
//
// The apps/web README "Mounting" contract: the host wires the rendered
// `/flows/*` form actions (`data-flow` attributes — including the onboarding
// `/flows/onboarding-enroll-device` and `/flows/onboarding-finish`, and the
// workspace connector enrollment `/flows/provision-connector`) to the
// matching typed flow methods on `CustomerWebApp`. THE HOST OWNS
// SESSIONS/CSRF; the app never sees credentials (RL-LOCK-016). After a
// connector-enrollment command the host redirects to
// `/workspace?commandId=<ack.commandId>` so the page renders the command's
// four-stage pipeline from the status read.
//
// Fail-closed laws (the host never invents success):
//   - runtime-not-ready → typed 503 HOST_NOT_READY
//   - unknown flow name → typed 404 FLOW_NOT_FOUND
//   - CSRF (same-origin) missing/invalid → typed 403 CSRF_INVALID
//   - session cookie absent/unresolvable → 303 to /login (the host's login
//     redirect discipline; never an invented session)
//   - form fields missing/invalid → re-render the originating page with the
//     typed validation error panel (the app's own mutation-result error panel)
//   - flow failure → re-render with the typed error panel (the app's flow
//     methods already wrap the typed `ApiClientError`)
//   - flow success + redirect law (provision-connector / onboarding-finish)
//     → 303 to the law's target
//   - flow success + render law → 200 with the rendered page (the
//     `lastResult` panel above the body)
// ---------------------------------------------------------------------------

/**
 * The host's CSRF defense: a same-origin POST check at the seam. The session
 * cookie is `SameSite=Lax` (already blocking cross-site form POSTs); this
 * check rejects any POST that lacks a same-origin `Origin` (or, in its
 * absence, a same-origin `Referer`). The app's rendered forms need NO CSRF
 * token field — the host owns CSRF at the seam (RL-LOCK-016: the app never
 * sees credentials, never sees the CSRF surface either).
 */
function isSameOriginPost(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === url.origin;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }
  // No Origin and no Referer: fail closed. A same-origin browser POST always
  // sends at least one (the only legitimate case where both are absent is a
  // same-site navigation triggered by a non-form UI, never a mutation).
  return false;
}

/** The typed 404 for an unwired flow name. */
function flowNotFoundResponse(flowName: string): Response {
  return errorResponse(
    HTTP_STATUS.notFound,
    "FLOW_NOT_FOUND",
    `the flow "${flowName}" is not wired (no host-side handler exists for /flows/${flowName})`,
  );
}

/** The typed 403 for a CSRF (same-origin) failure. */
function csrfInvalidResponse(): Response {
  return errorResponse(
    HTTP_STATUS.forbidden,
    "CSRF_INVALID",
    "the form submission failed the host's same-origin check (CSRF defense); no mutation was attempted",
  );
}

export async function handleFlowSubmit(request: Request, runtime: HostRuntime): Promise<Response> {
  // 1. Runtime gate — a refused composition refuses every flow (fail-closed).
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; no flow is accepted");
  }
  const url = new URL(request.url);
  const pathname = url.pathname;
  // 2. Path + flow-name resolution — a path that is not a flow action is the
  //    honest typed 404 (never a guess, never a fall-through to a GET).
  if (!pathname.startsWith(FLOW_PATH_PREFIX)) {
    return flowNotFoundResponse(pathname);
  }
  const flowName = pathname.slice(FLOW_PATH_PREFIX.length);
  if (flowName.length === 0 || flowName.includes("/")) {
    return flowNotFoundResponse(flowName);
  }
  const handler: FlowHandler | undefined = FLOW_HANDLERS[flowName];
  if (handler === undefined) {
    return flowNotFoundResponse(flowName);
  }
  // 3. CSRF — same-origin POST required (SameSite=Lax is the cookie's first
  //    line of defense; this is the seam's second line). A failure is the
  //    typed 403, never a redirect (a redirect could leak state to a
  //    cross-origin page).
  if (!isSameOriginPost(request, url)) {
    return csrfInvalidResponse();
  }
  // 4. Session — required. Absent or unresolvable → the host's login
  //    redirect discipline (303 to /login; never an invented session).
  const token = sessionTokenOf(request.headers.get("cookie") ?? undefined);
  if (token === undefined) return redirectTo("/login");
  let surfaceClient: SurfaceClient;
  try {
    surfaceClient = await resolveSurfaceClient(runtime.composition.api, token);
  } catch (error) {
    if (error instanceof SessionResolutionError) return redirectTo("/login");
    return internalErrorResponse();
  }
  // 5. Form-encoded parse — the rendered forms POST `application/x-www-form-
  //    encoded` by default (no enctype set). `request.formData()` accepts
  //    both that and multipart (defensive); a malformed body is the typed
  //    400, never a fall-through.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      HTTP_STATUS.badRequest,
      "FORM_INVALID",
      "the form submission was not a valid form-encoded body",
    );
  }
  // 6. Parse → typed flow-method input. A `FormValidationError` becomes the
  //    typed validation error panel (rendered on the originating page, so
  //    the customer sees the form again with the typed failure above it).
  const app = new CustomerWebApp({ client: surfaceClient.client });
  const idempotencyKey = `${flowName}-${crypto.randomUUID()}`;
  const ctx: FlowRunContext = { app, idempotencyKey };
  let result: MutationFlowResult;
  try {
    const typedInput = handler.parse(form);
    result = await handler.run(ctx, typedInput);
  } catch (error) {
    if (error instanceof FormValidationError) {
      result = { status: "error" as const, error: formValidationErrorOf(error) };
    } else {
      return internalErrorResponse();
    }
  }
  // 7. Response — redirect law first, then the rendered result.
  if (result.status === "ok" && handler.redirectOnSuccess !== undefined) {
    const target = handler.redirectOnSuccess(form, result.acknowledgement);
    if (target !== null) return redirectTo(target);
  }
  // The render law: re-render the originating page with the `lastResult`
  // panel above the body. The originating page is the page that hosts the
  // form (the form came from there; the customer's expectation is to land
  // back on it with the outcome visible).
  if (handler.renderPath === undefined) {
    // No render target and no redirect: an internal misconfiguration (never
    // a state the customer should see). Fail-closed — never invented success.
    return internalErrorResponse();
  }
  const renderTarget = handler.renderPath(form);
  try {
    return htmlResponse(
      await renderCustomerDocument(runtime.composition.api, token, renderTarget.pathname, {
        lastResult: result,
        ...(renderTarget.searchParams !== undefined ? { searchParams: renderTarget.searchParams } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof SessionResolutionError) return redirectTo("/login");
    if (error instanceof SurfaceNotFoundError) {
      return flowNotFoundResponse(flowName);
    }
    return internalErrorResponse();
  }
}

// ---------------------------------------------------------------------------
// The host session layer (login document + the cookie-binding submit)
// ---------------------------------------------------------------------------

/**
 * The login document. The demo environment's public roster (quick action
 * sign-in forms) renders ONLY when the composition booted AND the
 * ROAMLINK_DEMO_ACCOUNTS gate enabled it; a refused composition still serves
 * the plain credential form (the submit then answers the honest 503).
 */
export function handleLoginPage(runtime: HostRuntime): Response {
  const demoAccounts = runtime.ok ? runtime.composition.demo.accounts : undefined;
  return htmlResponse(renderLoginDocument(undefined, demoAccounts));
}

const PLACEHOLDER_ACTOR = "usr:unauthenticated";
const PLACEHOLDER_TENANT = "usr:unauthenticated";

/**
 * The form submit binding: the typed login command (POST /v1/auth/session)
 * through the REAL API service, the response token turned into the httpOnly
 * session cookie, everything else re-renders the login document with the
 * API's typed message. The token is handled exactly once here and never
 * stored outside the cookie (RL-LOCK-016).
 *
 * The mutation envelope's actor/tenant headers are REQUIRED by the /v1
 * contract even for login; pre-authentication the host sends the explicit
 * `unauthenticated` placeholder (never a real-looking identity) - the
 * service itself resolves the true actor/tenant from the credential.
 */
export async function handleLoginSubmit(request: Request, runtime: HostRuntime): Promise<Response> {
  if (!runtime.ok) {
    return errorResponse(503, "HOST_NOT_READY", "the hosted runtime is not ready; sign-in is unavailable");
  }
  let email: unknown;
  let password: unknown;
  try {
    const form = await request.formData();
    email = form.get("email");
    password = form.get("password");
  } catch {
    return htmlResponse(
      renderLoginDocument("the sign-in form was not submitted correctly - try again"),
      HTTP_STATUS.badRequest,
    );
  }
  if (typeof email !== "string" || typeof password !== "string" || email.length === 0) {
    return htmlResponse(
      renderLoginDocument("email and password are required"),
      HTTP_STATUS.badRequest,
    );
  }
  const loginRequest = {
    method: "POST" as const,
    path: "/v1/auth/session",
    headers: {
      "content-type": "application/json",
      "x-roamlink-request-id": crypto.randomUUID(),
      "x-roamlink-correlation-id": crypto.randomUUID(),
      "idempotency-key": `login-${crypto.randomUUID()}`,
      "x-roamlink-actor-id": PLACEHOLDER_ACTOR,
      "x-roamlink-tenant-id": PLACEHOLDER_TENANT,
    },
    body: JSON.stringify({ email, password }),
  };
  const response = await runtime.composition.api.handle(loginRequest);
  if (response.status !== 200 || response.body === undefined) {
    const message = loginErrorMessageOf(response.body);
    return htmlResponse(renderLoginDocument(message), response.status);
  }
  let outcome: LoginOutcome;
  try {
    outcome = JSON.parse(response.body) as LoginOutcome;
  } catch {
    return internalErrorResponse();
  }
  if (typeof outcome.token !== "string" || typeof outcome.expiresAt !== "string") {
    return internalErrorResponse();
  }
  const mode = isProductionRuntime() ? "production" : "development";
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": sessionCookieOf(outcome, { mode, now: () => Date.now() }),
    },
  });
}

/** The host's cleared-cookie binding (the durable session itself expires server-side). */
export function handleSessionClear(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/login", "set-cookie": clearedSessionCookie() },
  });
}

function loginErrorMessageOf(body: string | undefined): string {
  if (body === undefined) return "sign-in failed (details suppressed)";
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["message"] === "string"
    ) {
      return (parsed as Record<string, unknown>)["message"] as string;
    }
  } catch {
    // fall through to the suppressed message
  }
  return "sign-in failed (details suppressed)";
}

function isProductionRuntime(): boolean {
  return process.env["NODE_ENV"] === "production";
}
