/**
 * @roamlink/compat - the ADCOS compatibility suite (RL-036).
 *
 * The executable form of spec/adcos-integration.md §9: startup/integration
 * tests verifying endpoint/schema availability, required lifecycle states,
 * required fields/enums, signature/webhook semantics, idempotency behavior
 * and version compatibility. The supported ADCOS contract version is
 * configured in ONE place (ADCOS_API_VERSION in @roamlink/adcos, proven
 * consistent with the contracts env pin by a suite check).
 *
 * Incompatible ADCOS versions FAIL CLOSED for mutations: apply the suite
 * report to an AdcosCompatibilityState and adapter mutations are refused
 * with a diagnosable health state.
 *
 * Test-double discipline (§10): the suite runs against any public
 * AdcosClient - the local fake in tests, real clients at startup. No test
 * depends on ADCOS internals.
 */
export * from "./suite.js";
