/** The login submit binding: typed login command -> httpOnly session cookie. */
import { handleLoginSubmit } from "../../../handlers.js";
import { portalHostRuntime } from "../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleLoginSubmit(request, await portalHostRuntime());
}
