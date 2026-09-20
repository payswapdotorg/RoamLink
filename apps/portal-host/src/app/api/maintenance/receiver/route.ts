/**
 * /api/maintenance/receiver (RL-110): the event-driven maintenance path's
 * signed-job receiver. QStash delivers the maintenance jobs the cron
 * enqueued; this endpoint VERIFIES the signature before acting (fail-closed
 * on unconfigured keys) and executes the same bounded sweeps the inline
 * trigger would. The real dispatch lives in handlers.ts.
 */
import { handleMaintenanceReceiver } from "../../../../handlers.js";
import { portalHostRuntime } from "../../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMaintenanceReceiver(request, await portalHostRuntime());
}
