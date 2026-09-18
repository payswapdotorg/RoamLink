/** Readiness: REAL checks - the database answers AND the migration ledger is applied. */
import { handleReadyz } from "../../handlers.js";
import { portalHostRuntime } from "../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return handleReadyz(await portalHostRuntime());
}
