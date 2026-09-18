/**
 * Fail-closed environment access for the Neon path (RL-095).
 *
 * DATABASE_URL is owned by the root env schema (packages/contracts,
 * RL-001); this module re-reads the SAME key and refines it into a
 * validated {@link NeonConnectionConfig}. It never invents parallel env
 * keys (the root conformance test pins .env.example exactly) and never
 * leaks values (RL-LOCK-016).
 */
import { parseNeonConnectionString, type NeonConnectionConfig } from "./config.js";

export type NeonEnvSource = Readonly<Record<string, string | undefined>>;

export type ParseNeonEnvResult =
  | { readonly ok: true; readonly config: NeonConnectionConfig }
  | { readonly ok: false; readonly error: Error };

/**
 * Reads `DATABASE_URL` from the environment source and validates it as a
 * Neon driver-path connection string. Absent/blank keys fail with a
 * value-free error naming the KEY only.
 */
export function tryParseNeonEnv(source: NeonEnvSource): ParseNeonEnvResult {
  const raw = source["DATABASE_URL"];
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      error: new NeonEnvError("DATABASE_URL", "required for the Neon driver path (see infra/deployment/providers/neon.env.example)"),
    };
  }
  const parsed = parseNeonConnectionString(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, config: parsed.config };
}

/** Typed env error: names the KEY, never the value (RL-LOCK-016). */
export class NeonEnvError extends Error {
  readonly key: string;

  constructor(key: string, problem: string) {
    super(`Neon environment validation failed for key '${key}': ${problem}`);
    this.key = key;
    this.name = "NeonEnvError";
    Object.freeze(this);
  }
}
