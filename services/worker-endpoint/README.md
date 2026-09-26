# @roamlink/worker-endpoint

The authenticated **bounded worker-tick endpoint** (PA-025) — the live
command-execution path for the low-cost hosted demo. The sanctioned topology
(spec/deployment.md §3/§4) closes here:

```
Neon durable outbox
  -> QStash (the recurring scheduled delivery)
    -> THIS endpoint (QStash-signature-verified, bounded)
      -> the services/workers execution seam
        (createBoundedWorkerTick over commandLedgerDeliveryPort
         + createCommandLedger)
        -> executed-stage CAS writes + outbox outcome commits
          -> the read models serve REAL projections
```

## Why an isolated service plane

The architectural choice (narrated in `src/index.ts`): the endpoint's
authentication plane is **QStash signature verification** (machine-to-machine,
receiver-side rigor — constant-time compare, replay window both directions,
closed value-free failure codes) while `services/api`'s routes are
**session-authenticated**. Mixing the two in one dispatcher would blur the
API surface's contract — and `services/api` cannot depend on
`services/workers` without a cycle (workers already composes the API's
command-ledger repository). This leaf service depends only on
`@roamlink/workers` (the execution seam), `@roamlink/provider-qstash` (the
verifier) and the persistence adapter.

The provider import uses the package's **runtime-clean subpath**
(`@roamlink/provider-qstash/runtime`, added by this item): the root export
re-exports the vitest-dependent contract battery (the ADR-0003
replacement-rule surface for TESTS), which cannot be imported outside a
vitest run — a deployed request handler must never transitively import a
test runner. The same one-line specifier fix in `services/workers/host.ts`
also repairs the pre-existing `pnpm --filter @roamlink/workers start`
crash (the standalone host now reaches its honest composition refusal
instead of a vitest internal-state error).

## The bound law

A request handler is **never** an unbounded long-running worker. Every
delivery executes exactly ONE bounded tick and returns:

1. **sweep** — `recoverInFlight(at)` re-owns claims stranded by a previous
   crashed/stopped invocation (AR-007/RL-093; idempotent set-transition,
   budget untouched);
2. **capped claim** — `claimDue(at, batchSize)` committed BEFORE any attempt;
3. **deliver + outcome** — per claimed obligation: the executor applies the
   command, the command-ledger `markExecuted` CAS write records the executed
   stage (+ the resource execution created), the outbox outcome commits in
   its own unit of work. The **max-duration guard** stops a batch that would
   exceed the budget AFTER the current item — the un-attempted remainder
   strands safely in DELIVERING and the next scheduled delivery's sweep
   re-owns it (honest partial progress);
4. **one bounded inbox batch** (+ optionally one reconciliation tick) when
   their sources are composed — otherwise the honest skip.

The SAME execution seam stays usable by the production long-running host
(`services/workers` `main.ts`) **unchanged**.

## The receiver law (verify before acting)

| Delivery | Answer |
|---|---|
| no receiver-side signing keys configured | `503` — every delivery refused, never acted on |
| unsigned / malformed / wrong key / outside the replay window / body not covered | `401` with the closed, value-free code (`signature-missing`, `signature-malformed`, `signature-invalid`, `timestamp-outside-window`, `payload-too-large`) — the tick NEVER runs |
| payload without `kind: "worker.tick"` / unreadable JSON | typed `400` (the transport retries/dead-letters) |
| verified tick | `200` with the honest outcome summary — observability only (claimed/executed/delivered counts, remaining backlog, honest skips), never business state |
| the tick itself failed | `500` (details suppressed) — the transport retries; the claim/outcome discipline is crash-safe |

## The executor table (the demo's composed command handlers)

`src/executors.ts` composes the kinds whose read models are composed:
`device.enroll` / `device.update` / `device.retire` and
`experience-intent.create` / `.activate` / `.supersede`. The creating kinds
record their resource (`{type, id, version}`) in the SAME `executed` CAS
write — the fact the PA-019 command-ledger read projections project from
("a device exists from execution"). Every OTHER kind keeps the honest
outbox law: RETRYABLE failure with the diagnosable reason
`COMMAND_EXECUTOR_NOT_COMPOSED` — a rolling deploy that adds an executor
self-heals; never silently dropped, never faked.

## Wiring the schedule (the setup path)

```bash
pnpm --filter @roamlink/worker-endpoint schedule:publish
```

Publishes the recurring QStash delivery of the `{"kind":"worker.tick"}` job
to `ROAMLINK_WORKER_TICK_DESTINATION` on the `ROAMLINK_WORKER_TICK_CRON`
cadence (idempotent: an identical destination+cron schedule is reported and
skipped). Exit codes: `0` published/already-present, `1` configuration
refused, `2` provider error.

**Cadence law** (spec/deployment.md §8): the cron expression is the
operator's budgeted choice — the Upstash free tier's ~1,000 messages/day is
a deployment fact to respect with headroom (an every-five-minutes cadence
fires 288/day), NEVER a correctness fact: the receiver executes one bounded,
idempotent tick per delivery, so any cadence is safe.

See `infra/deployment/environments/demo.env.example` (the wiring keys) and
`infra/deployment/provider-wiring.md` (the manifest row).

## Honest gaps

- **The executor table is the DEMO's** — the kinds beyond the composed read
  models (orders, payments, notifications, eSIM, connector provisioning,
  support cases, organizations) honestly retry with
  `COMMAND_EXECUTOR_NOT_COMPOSED` until their executors land (the execution
  wave); their read models keep their typed 501s independently.
- **The delivered/billable-final stages** are not this item's writes:
  `executed` is (the CAS write through the command ledger); `delivered` on
  the COMMAND record and `billableFinalAt` belong to the delivery-wave
  writers. Stages never collapse.
- **The schedule API is wire-pinned, not yet live-confirmed** — the
  publish/verify routes carry the PA-017 live evidence; the schedule route
  follows the same single-sited pin discipline with the deterministic fake
  as the contract reference until the operator's live confirmation run.
