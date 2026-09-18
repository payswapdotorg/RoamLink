/**
 * The /v1 API/BFF mount (RL-089 -> RL-090): transport translation ONLY.
 * The real dispatch lives in services/api; the composition in bootstrap.ts.
 */
import { handleV1 } from "../../../handlers.js";
import { portalHostRuntime } from "../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleV1(request, await portalHostRuntime());
}

export async function POST(request: Request): Promise<Response> {
  return handleV1(request, await portalHostRuntime());
}
