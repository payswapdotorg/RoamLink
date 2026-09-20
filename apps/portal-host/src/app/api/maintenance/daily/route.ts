/**
 * /api/maintenance/daily (RL-107): the thin, authenticated, idempotent
 * maintenance trigger the deployment's cron calls (vercel.json) — it kicks
 * the recovery sweeps, it is NOT a long-running job in a serverless route
 * (spec/deployment.md §5). The real dispatch lives in maintenance.ts.
 */
import { handleMaintenanceDaily } from "../../../../handlers.js";
import { portalHostRuntime } from "../../../../bootstrap.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleMaintenanceDaily(request, await portalHostRuntime());
}
