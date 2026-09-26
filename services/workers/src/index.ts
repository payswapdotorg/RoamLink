/**
 * @roamlink/workers - the production worker host (RL-107) + the ADCOS
 * compatibility probe entry points (RL-108).
 *
 * Layout:
 *  - `host.ts`          the worker composition: outbox drain + inbox drain
 *                       + reconciliation schedule over the REAL persistence,
 *                       the RL-108 probe, and the honest readiness surface;
 *  - `outbox-drain.ts`  the bounded `claimDue` loop with the RL-093
 *                       `recoverInFlight` startup sweep (sweep BEFORE the
 *                       first claim), terminal-state handling and graceful
 *                       shutdown;
 *  - `inbox-drain.ts`   the bounded webhook-inbox `processPending` schedule
 *                       (projection is the worker's concern - RL-LOCK-009);
 *  - `delivery.ts`      the outbox delivery ports (QStash handoff, the
 *                       in-process command-executor port) and their closed
 *                       outcome vocabulary;
 *  - `command-ledger.ts` the `executed`-stage writer over the SAME
 *                       `api-commands` repository the API ingested into
 *                       (stages never collapse or lie - spec/api.md);
 *  - `tick.ts`          the bounded SINGLE-TICK composition (PA-025): one
 *                       sweep + one capped claim batch through the delivery/
 *                       outcome path + one bounded inbox batch (+ optionally
 *                       one reconciliation tick), with the max-duration
 *                       partial-progress guard - the free-tier-compatible
 *                       execution path the authenticated worker endpoint
 *                       drives; the production host's loop is unchanged;
 *  - `enterprise-executors.ts` the enterprise command executors (PA-026):
 *                       the @roamlink/enterprise domain's own transition
 *                       functions (enrollment journey + connector
 *                       negotiation) over the shared-persistence store
 *                       adapters, composable into commandLedgerDeliveryPort
 *                       on the same bounded-tick path;
 *  - `timer.ts`         the injectable timer port (deterministic tests).
 *
 * `src/main.ts` is the standalone long-running entry; `scripts/adcos-probe.ts`
 * is the standalone, exit-distinct production ADCOS probe (RL-108).
 */
export * from "./timer.js";
export * from "./delivery.js";
export * from "./command-ledger.js";
export * from "./enterprise-executors.js";
export * from "./outbox-drain.js";
export * from "./inbox-drain.js";
export * from "./tick.js";
export * from "./host.js";
