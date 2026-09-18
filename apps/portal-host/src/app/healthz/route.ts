/** Liveness: the process is up (no dependency calls - readiness owns those). */
import { handleHealthz } from "../../handlers.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return handleHealthz();
}
