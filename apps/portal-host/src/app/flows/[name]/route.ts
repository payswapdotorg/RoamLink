/**
 * The /flows/* form-action POST handler (PA-018 — closes F-016-1).
 *
 * The portal host owns the wiring of the rendered `/flows/*` form actions
 * (apps/web README "Mounting") to the matching typed flow methods on
 * `CustomerWebApp`. The host owns sessions/CSRF; the app never sees
 * credentials (RL-LOCK-016). All transport logic lives in `handleFlowSubmit`
 * (`handlers.ts`); this file is a three-line forwarder only.
 */
import { handleFlowSubmit } from "../../../handlers.js";
import { portalHostRuntime } from "../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleFlowSubmit(request, await portalHostRuntime());
}
