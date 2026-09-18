/** The admin console surface (apps/admin mounted under /admin). */
import { handleAdminSurface } from "../../../handlers.js";
import { portalHostRuntime } from "../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleAdminSurface(request, await portalHostRuntime());
}
