/** The customer web surface (apps/web mounted under "/"), including the root. */
import { handleCustomerSurface } from "../../handlers.js";
import { portalHostRuntime } from "../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleCustomerSurface(request, await portalHostRuntime());
}
