/**
 * The hosted runtime's composition bootstrap (RL-089).
 *
 * ONE memoized composition per process, built from the environment ONLY
 * (spec/deployment.md: all secrets arrive through the environment; nothing
 * is hard-coded, RL-LOCK-016). A refusal to boot is MEMOIZED too: the
 * fail-closed answer must not depend on request order, and the readiness
 * endpoint keeps reporting the refusal honestly instead of flapping.
 */
import { createPortalHostComposition, type PortalHostComposition } from "./composition.js";

export type HostRuntime =
  | { readonly ok: true; readonly composition: PortalHostComposition }
  | { readonly ok: false; readonly error: unknown };

let memoized: Promise<HostRuntime> | undefined;

/** The host environment (parsed once per process; no defaults, no fakes). */
export function portalHostEnvFromProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  mode: "production" | "development";
  databaseUrl: string | undefined;
  webhookSigningKeys: string | undefined;
  webhookEnvironment: string | undefined;
} {
  return {
    mode: env["NODE_ENV"] === "production" ? "production" : "development",
    databaseUrl: env["DATABASE_URL"],
    webhookSigningKeys: env["ROAMLINK_WEBHOOK_SIGNING_KEYS"],
    webhookEnvironment: env["ROAMLINK_WEBHOOK_ENVIRONMENT"],
  };
}

/** The memoized composition (or the memoized refusal). */
export function portalHostRuntime(): Promise<HostRuntime> {
  memoized ??= createPortalHostComposition(portalHostEnvFromProcessEnv()).then(
    (composition): HostRuntime => ({ ok: true, composition }),
    (error: unknown): HostRuntime => ({ ok: false, error }),
  );
  return memoized;
}

/** Test seam: resets the memoized runtime (process-level state). */
export function resetPortalHostRuntime(): void {
  memoized = undefined;
}
