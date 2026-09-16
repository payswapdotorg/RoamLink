/**
 * @roamlink/app-kit - the application kit for the RL-060 customer web app and
 * the RL-061 admin/operations console.
 *
 * The single shared place where the PUBLIC APPLICATION API contract
 * (spec/api.md) is expressed as typed, fail-closed TypeScript: wire resource
 * shapes + parsers, the command-acknowledgement semantics, the typed API
 * client over an injectable transport port, a deterministic in-memory fake
 * API implementing the same contract, and framework-free UI primitives
 * (HTML-safe rendering, freshness/evidence badges, the mutation-stage
 * pipeline).
 *
 * Authority discipline (spec/repository-layout.md "apps consume public
 * application APIs/read models"): this package holds ZERO domain authority.
 * It depends ONLY on @roamlink/contracts (shared primitives: error taxonomy,
 * freshness, UTC instants, command ids). It never imports a domain,
 * integration, edge or platform package - the API service (services/, a later
 * wave) implements the same contract over the domain modules, and the
 * contract drift between the two is what the conformance suite guards.
 */
export const APP_KIT_VERSION = "0.1.0" as const;
