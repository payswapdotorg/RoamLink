/**
 * @roamlink/testkit - deterministic test primitives (RL-040 platform
 * scaffolding).
 *
 * Dependency-free (the only runtime dependency is the Wave-0 contracts
 * package): deterministic clock, deterministic ID generators, in-memory
 * event/command recorders and fixture builders for the Wave-0 contract
 * types. No domain logic, no business authority, no platform assumptions.
 */
export * from "./clock.js";
export * from "./ids.js";
export * from "./recorder.js";
export * from "./fixtures/contracts-fixtures.js";
