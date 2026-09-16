/**
 * Canonical resource discovery (RL-035, spec §7 "missed webhooks").
 *
 * A projection the reconciler has never seen cannot be found by scanning the
 * projection store alone - the FIRST event of a resource may have been
 * dropped before admission. Discovery enumerates canonical resources through
 * the public ADCOS list routes (spec §3: list intents / contracts / leases /
 * webhook endpoints) so those resources enter the reconciliation scan set.
 *
 * Discovery is best-effort breadth: a failing route is skipped (recorded as
 * a DEFERRED DISCOVERY action with the closed error code) while the other
 * routes still contribute. It never mutates ADCOS (RL-LOCK-001).
 */
import { DomainError } from "@roamlink/contracts";
import type { AdcosClient } from "@roamlink/adcos";
import {
  isAdcosProjectionResourceType,
  type AdcosProjectionResourceType,
} from "@roamlink/projections";

/** One canonical resource the reconciler should know about. */
export interface DiscoveredCanonicalResource {
  readonly resource_type: AdcosProjectionResourceType;
  readonly resource_id: string;
}

/** A route that failed during discovery (log-safe: route + code only). */
export interface DiscoveryRouteFailure {
  readonly route: string;
  readonly code: string;
}

export interface DiscoveryResult {
  /** Deterministically ordered (by type, then id). */
  readonly resources: readonly DiscoveredCanonicalResource[];
  readonly routeFailures: readonly DiscoveryRouteFailure[];
}

/** The discovery port. Implementations never mutate ADCOS. */
export interface CanonicalResourceDiscovery {
  discover(): Promise<DiscoveryResult>;
}

const DISCOVERY_ROUTES = [
  { route: "intent_list", resourceType: "connectivity_intent", list: (client: AdcosClient) => client.listIntents() },
  { route: "contract_list", resourceType: "connectivity_contract", list: (client: AdcosClient) => client.listContracts() },
  { route: "lease_list", resourceType: "connectivity_lease", list: (client: AdcosClient) => client.listLeases() },
  {
    route: "webhook_endpoint_list",
    resourceType: "webhook_endpoint",
    list: (client: AdcosClient) => client.listWebhookEndpoints(),
  },
] as const;

/**
 * Extracts a resource id from an opaque listed document. Documents are NOT
 * field-pinned by the v2 facts, so a missing/invalid `id` member simply
 * contributes nothing - discovery never guesses (RL-LOCK-010).
 */
function documentIdOf(document: unknown): string | null {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  const id = (document as Record<string, unknown>)["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > 255) return null;
  return id;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if (error instanceof DomainError) return error.reason;
  return "DISCOVERY_FAILED";
}

/**
 * The default discovery over the public ADCOS client list routes. Read-only;
 * deterministic ordering; per-route failures degrade to that route only.
 */
export class AdcosClientResourceDiscovery implements CanonicalResourceDiscovery {
  readonly #client: AdcosClient;

  constructor(client: AdcosClient) {
    this.#client = client;
  }

  async discover(): Promise<DiscoveryResult> {
    const resources: DiscoveredCanonicalResource[] = [];
    const routeFailures: DiscoveryRouteFailure[] = [];
    for (const entry of DISCOVERY_ROUTES) {
      try {
        const page = await entry.list(this.#client);
        for (const document of page.items) {
          const id = documentIdOf(document);
          if (id === null) continue;
          if (!isAdcosProjectionResourceType(entry.resourceType)) continue;
          resources.push({ resource_type: entry.resourceType, resource_id: id });
        }
      } catch (error) {
        routeFailures.push({ route: entry.route, code: errorCodeOf(error) });
      }
    }
    resources.sort((a, b) =>
      a.resource_type < b.resource_type
        ? -1
        : a.resource_type > b.resource_type
          ? 1
          : a.resource_id < b.resource_id
            ? -1
            : a.resource_id > b.resource_id
              ? 1
              : 0,
    );
    return Object.freeze({
      resources: Object.freeze(resources),
      routeFailures: Object.freeze(routeFailures),
    });
  }
}
