# @roamlink/workers

The production worker host (RL-107) and the production ADCOS compatibility
probe entry points (RL-108). services/api records commands and admits
webhooks; NOTHING else drains them — this service is the process that does.

## What the host composes

| Loop | Ports consumed | Semantics |
| --- | --- | --- |
| **Outbox drain** | `claimDue` / `markDelivered` / `markAttemptFailed` / `recoverInFlight` (the LANDED recovery port, AR-007/RL-093 — consumed, not modified) | Startup sweep BEFORE the first claim (claims stranded in DELIVERING by a crash re-own to PENDING due at the recovery instant, retry budget untouched), then a bounded `claimDue` loop: claim-commit → deliver through the delivery port → outcome-commit. Terminal states (DELIVERED/FAILED) are never resurrected. Graceful `stop()` finishes the in-flight tick; an abandoned mid-batch claim re-owns on restart (pinned in tests). |
| **Inbox drain** | `AdcosWebhookInboxService.processPending` (the LANDED terminal-state batch progression, AR-008/RL-094) | Bounded projection batches in admission order; PROJECTED is terminal and never re-projected; repeated bounded ticks advance through any backlog. |
| **Reconciliation** | `AdcosReconciliationScheduler` + `createAdcosReconciliationBoundary` (composed exactly as the verification suites compose them) | The scheduler's injectable timer keeps tests deterministic; production paces at `reconciliationIntervalMs` (default 5 min). Projections are DISPOSABLE (spec/architecture.md §5): the in-memory store is the sanctioned projection store in this tree; a restart re-discovers and re-repairs by design. |
| **ADCOS probe** (RL-108) | `runAdcosProductionProbe` (`@roamlink/compat`) | Env-gated; the full §9 suite runs against the REAL endpoint at startup and the report is applied to the exposed `AdcosCompatibilityState` (fail-closed mutations). Absent env → `not-configured` (honest, never blocking). |

## Readiness (the honest closed vocabulary)

The host composes into `ready | degraded:<deps> | not-ready:<reasons>`:

- `database` (REQUIRED) and `migrations` (REQUIRED) — a worker that cannot
  reach the database is **not-ready**, never ready-with-secrets-suppressed;
- `outbox-delivery` (OPTIONAL) — degraded when no delivery channel is
  composed (QStash env unset and no delivery port bound): the drain is
  honestly DISABLED and the records stay PENDING (the documented wave gap),
  never a fake delivery, never a silently idle queue;
- `adcos-compatibility` (OPTIONAL) — healthy when the probe passed; degraded
  with the value-free failed-check names when incompatible (mutations fail
  closed).

## Delivery channels (the `OutboxDeliveryPort`)

1. **QStash handoff** (production default): each obligation is handed to the
   QStash `DurableJobDeliveryPort` (the sanctioned retryable async channel);
   the outbox obligation is DELIVERED when the handoff receipt is accepted.
   Configure `QSTASH_TOKEN` + `ROAMLINK_OUTBOX_DELIVERY_DESTINATION`.
2. **Command executors** (in-process): `commandLedgerDeliveryPort` executes
   command obligations through composed executors and records the
   `executed` stage on the stored command (`api-commands`) — the
   acknowledgement stages never lie (spec/api.md). A kind without a
   composed executor is a RETRYABLE failure with the diagnosable reason
   `COMMAND_EXECUTOR_NOT_COMPOSED`.
3. **None**: no drain composed; readiness degrades; records stay PENDING.

## Running

```bash
pnpm --filter @roamlink/workers start        # the long-running host
pnpm --filter @roamlink/workers adcos:probe  # the standalone probe (exit-distinct)
```

The standalone probe exit codes are DISTINCT: `0` compatible,
`1` incompatible (mutations fail closed), `2` not-configured (honest; never
blocks local/CI runs).

## Honest gaps

- **Domain command executors are not yet composed** — with no delivery
  channel bound the outbox drain is disabled and records stay PENDING
  (visible, honest backlog). Composing executors is the execution wave.
- **Projection store durability** — the reconciliation boundary composes the
  in-memory projection store (disposable by spec §5); a durable store is a
  separate work item.
- **Identity durability** — unchanged from services/api (the documented gap).
