/**
 * @roamlink/worker-endpoint — the authenticated bounded worker-tick endpoint
 * (PA-025, the live command-execution path).
 *
 * An ISOLATED SERVICE PLANE (the architectural choice, narrated): the
 * endpoint's authentication plane is QStash SIGNATURE verification
 * (machine-to-machine, receiver-side rigor) while services/api's routes are
 * SESSION-authenticated — mixing the two in one dispatcher would blur the
 * API surface's contract, and services/api cannot depend on
 * services/workers without a dependency cycle (workers already composes the
 * API's command-ledger repository). This leaf service depends only on
 * @roamlink/workers (the execution seam), @roamlink/provider-qstash (the
 * verifier) and the persistence adapter — the hosted runtime mounts it
 * through the portal-host's route table exactly the way the maintenance
 * receiver (RL-110) mounts, and the production long-running worker host
 * keeps the SAME seam unchanged.
 *
 * Layout:
 *  - `endpoint.ts`   verify-then-tick: the QStash signature gate (fail-closed
 *                    401/503 vocabulary), ONE bounded tick per invocation,
 *                    the honest outcome summary (observability only);
 *  - `executors.ts`  the demo's composed command handlers — the kinds whose
 *                    read models are composed (devices, experience intents)
 *                    advance to `executed` with their resource recorded;
 *                    every other kind keeps the honest
 *                    COMMAND_EXECUTOR_NOT_COMPOSED retryable failure;
 *  - `scripts/publish-tick-schedule.ts` the setup path: publishes the
 *                    recurring QStash delivery of the tick job to the
 *                    receiver URL (the provider's pinned schedule API).
 */
export * from "./executors.js";
export * from "./endpoint.js";
