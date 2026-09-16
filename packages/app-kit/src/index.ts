/**
 * @roamlink/app-kit - the shared application kit for the customer web app
 * (RL-060) and the admin/operations console (RL-061).
 *
 * Layout:
 *  - `api/*`   the public application API contract (wire resources + fail-
 *              closed parsers, mutation-outcome stages, command payloads,
 *              the route table, the typed client, the deterministic fake);
 *  - `ui/*`    the framework-free typed HTML core + shared UI components
 *              (freshness/evidence badges, the mutation-stage pipeline,
 *              connectivity rendering, error panels, page shell).
 */
export * from "./version.js";
export * from "./api/outcomes.js";
export * from "./api/context.js";
export * from "./api/transport.js";
export * from "./api/errors.js";
export * from "./api/parse-kit.js";
export * from "./api/resources.js";
export * from "./api/commands.js";
export * from "./api/routes.js";
export * from "./api/client.js";
export * from "./api/fake/seed.js";
export * from "./api/fake/in-memory-api.js";
export * from "./ui/html.js";
export * from "./ui/components.js";
