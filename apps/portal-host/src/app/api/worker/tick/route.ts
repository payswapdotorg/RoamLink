/**
 * /api/worker/tick (PA-025): the live command-execution path's receiver.
 * QStash delivers the recurring scheduled tick job; this endpoint VERIFIES
 * the signature before anything else (fail-closed on unconfigured keys or
 * any verification failure) and executes ONE bounded tick over the
 * services/workers execution seam. The real dispatch lives in handlers.ts.
 */
import { handleWorkerTick } from "../../../../handlers.js";
import { portalHostRuntime } from "../../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleWorkerTick(request, await portalHostRuntime());
}
