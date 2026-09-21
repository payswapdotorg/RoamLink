/** The host login document (the session layer's own page). */
import { handleLoginPage } from "../../handlers.js";
import { portalHostRuntime } from "../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return handleLoginPage(await portalHostRuntime());
}
