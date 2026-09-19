/**
 * The portal-host's readiness wiring (RL-100).
 *
 * The host reports its own process health AND (when the API service URL is
 * configured via ROAMLINK_API_BASE_URL) a bounded-timeout probe of that
 * API's composed readiness (GET /v1/readiness, the RL-100 surface). The
 * probe rides a REPLACEABLE port ({@link RemoteApiReadinessProbe}): the
 * real implementation is the bounded fetch, tests inject a fake - no
 * network in tests, honest in deployment.
 *
 * Mapping law (honest vocabulary end to end - a lying dependency can never
 * pass): the remote answer is classified by ITS OWN status vocabulary
 *   ready                  -> healthy
 *   degraded:<...>         -> degraded (the degradation propagates; the
 *                             detail carries the remote status verbatim,
 *                             which is our own bounded value-free
 *                             vocabulary - RL-LOCK-016-safe by contract)
 *   not-ready:<...> / 503  -> down (detail carries the remote status)
 *   anything else          -> down (an out-of-vocabulary answer is a lie,
 *                             never mapped onto healthy)
 *   timeout/error/garbage  -> down with a SUPPRESSED detail (RL-LOCK-016)
 *
 * The host's own database + migration-ledger checks stay exactly as real
 * as before (the persistence driver's liveness probe + the ledger query);
 * the composed report adds the honest status vocabulary on top without
 * changing the established checks/report shape (additive).
 */
import { nowUtc, type UtcInstant } from "@roamlink/contracts";
import type { HealthCheck, HealthCheckOutput, HealthState } from "@roamlink/observability";

/** The replaceable remote-API probe port (fake in tests, bounded fetch in deployment). */
export interface RemoteApiReadinessProbe {
  /** Runs one bounded probe; resolves with the honest mapped state. */
  readonly probe: () => Promise<{
    readonly state: HealthState;
    readonly detail?: string;
  }>;
}

export interface CreateRemoteApiReadinessProbeOptions {
  /** The API service base URL (no path; the probe appends /v1/readiness). */
  readonly baseUrl: string;
  /** Probe budget in ms (default 3000; serverless-safe, bounded). */
  readonly timeoutMs?: number;
  /** Injectable fetch (tests); defaults to global fetch (Node >= 22). */
  readonly fetchLike?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_DETAIL_LENGTH = 256;

function boundedDetail(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…` : value;
}

/**
 * Builds the bounded remote-API readiness probe. Absolute http(s) URL
 * required (fail fast at composition, never mid-probe); the request is
 * abort-bounded (serverless hosts kill long requests), redirect-following
 * is disabled (a readiness probe must not chase other surfaces).
 */
export function createRemoteApiReadinessProbe(
  options: CreateRemoteApiReadinessProbeOptions,
): RemoteApiReadinessProbe {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    throw new Error("the remote API base URL must be an absolute URL (ROAMLINK_API_BASE_URL)");
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("the remote API base URL must be http(s) (ROAMLINK_API_BASE_URL)");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)
  ) {
    throw new Error("the remote API probe timeoutMs must be an integer between 1 and 60000");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchLike ?? fetch;
  const probeUrl = new URL("/v1/readiness", baseUrl).toString();

  return {
    probe: async (): Promise<{ state: HealthState; detail?: string }> => {
      let response: Response;
      try {
        response = await doFetch(probeUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return {
          state: "down",
          detail: "the API service readiness probe failed (connection/timeout; detail suppressed)",
        };
      }
      if (response.status === 503) {
        const status = await statusVocabularyOf(response);
        return {
          state: "down",
          detail:
            status !== null
              ? boundedDetail(status)
              : "the API service is not ready (out-of-vocabulary body suppressed)",
        };
      }
      if (response.status !== 200) {
        return {
          state: "down",
          detail: `the API service readiness probe answered an unexpected status (${response.status})`,
        };
      }
      const parsed: unknown = await jsonBodyOf(response);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof (parsed as Record<string, unknown>)["status"] !== "string"
      ) {
        return {
          state: "down",
          detail: "the API service readiness answer was not the contracted vocabulary (suppressed)",
        };
      }
      const status = (parsed as Record<string, unknown>)["status"] as string;
      if (status === "ready") return { state: "healthy" };
      if (status.startsWith("degraded:")) return { state: "degraded", detail: boundedDetail(status) };
      if (status.startsWith("not-ready:")) return { state: "down", detail: boundedDetail(status) };
      return {
        state: "down",
        detail: "the API service readiness answer was outside the honest vocabulary (suppressed)",
      };
    },
  };
}

async function statusVocabularyOf(response: Response): Promise<string | null> {
  const parsed: unknown = await jsonBodyOf(response);
  if (parsed !== null && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)["status"] === "string") {
    return (parsed as Record<string, unknown>)["status"] as string;
  }
  return null;
}

async function jsonBodyOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export interface RemoteApiReadinessCheckOptions {
  readonly probe: RemoteApiReadinessProbe;
  /** Registry name (default `api`). */
  readonly name?: string;
  /** Injectable clock; defaults to the system clock (production). */
  readonly clock?: { now(): UtcInstant };
}

/**
 * The host-registered health check for the remote API dependency: the
 * bounded probe result (already honest-mapped) wrapped as a
 * HealthCheckOutput. The host classifies the `api` dependency as REQUIRED
 * when the URL is configured: its surfaces and /v1 mount depend on it.
 */
export function remoteApiReadinessCheck(options: RemoteApiReadinessCheckOptions): HealthCheck {
  const name = options.name ?? "api";
  const clock = options.clock ?? { now: () => nowUtc() };
  return {
    name,
    run: async (): Promise<HealthCheckOutput> => {
      const checkedAt = clock.now();
      try {
        const outcome = await options.probe.probe();
        return {
          name,
          state: outcome.state,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          checkedAt,
        };
      } catch {
        return {
          name,
          state: "down",
          detail: "the API service readiness probe threw (detail suppressed)",
          checkedAt,
        };
      }
    },
  };
}
