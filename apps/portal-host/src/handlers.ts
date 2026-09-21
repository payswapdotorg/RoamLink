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
import { HTTP_STATUS, el, fragment, htmlDocument, pageShell, text, type ActorSessionResource } from "@roamlink/app-kit";
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
  resolveWebPage,
} from "./surface.js";
import { resolveActorSession } from "./ops-surface.js";
import { opsSloSurfaceDocument } from "./ops-slo-page.js";
import { buildProductSloDashboard } from "@roamlink/observability";

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
  const pathname = new URL(request.url).pathname;
  // A path that is not a page of the mounted app is an honest 404 BEFORE the
  // session check (unknown pages never leak authentication state).
  if (resolveWebPage(pathname) === undefined) {
    return htmlResponse(surfaceNotFoundDocument(pathname), HTTP_STATUS.notFound);
  }
  const token = sessionTokenOf(request.headers.get("cookie") ?? undefined);
  if (token === undefined) return redirectTo("/login");
  try {
    return htmlResponse(await renderCustomerDocument(runtime.composition.api, token, pathname));
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
