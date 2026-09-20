/**
 * /ops/slo (RL-109): the HOST-SIDE operator SLO dashboard over the §11
 * observability bindings the composition owns (see src/slo.ts for the
 * architecture decision). Session-gated, fail-closed; the real dispatch
 * lives in handlers.ts (handleOpsSloSurface).
 */
import { handleOpsSloSurface } from "../../../handlers.js";
import { portalHostRuntime } from "../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleOpsSloSurface(request, await portalHostRuntime());
}
