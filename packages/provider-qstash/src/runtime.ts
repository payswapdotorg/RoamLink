/**
 * The RUNTIME-clean surface of the provider adapter (PA-025, additive).
 *
 * The package's root export deliberately re-exports the reusable
 * contract-test battery (`port-contract.ts`) for the ADR-0003 replacement
 * rule — that battery imports `vitest`, which is correct on the TEST plane
 * but CANNOT be imported outside a vitest run (the module throws when the
 * test runner's state is absent). Runtime consumers therefore import THIS
 * subpath (`@roamlink/provider-qstash/runtime`): the identical runtime
 * modules (port, verifier, fake, hosted client, schedule, env, health)
 * without the test-plane battery — so a deployed host's route bundle (the
 * bounded worker-tick endpoint and its setup script) never transitively
 * imports a test runner.
 */
export * from "./port.js";
export * from "./verifier.js";
export * from "./fake.js";
export * from "./upstash-qstash.js";
export * from "./schedule.js";
export * from "./env.js";
export * from "./health.js";
