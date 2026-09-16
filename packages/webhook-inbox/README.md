# @roamlink/webhook-inbox

The durable ADCOS webhook inbox (RL-033): authenticated, replay-protected,
immutable admission of inbound ADCOS v2 webhook events.

## Pipeline (spec/adcos-integration.md §6)

```
receive -> authenticate -> replay check -> persist immutable inbox record
       -> acknowledge -> async project
```

| Module | Responsibility |
|---|---|
| `src/verifier.ts` | `HmacWebhookVerifier` implementing the `WebhookVerifier` seam: the 7 delivery headers, HMAC-SHA256 over the canonical signature message (constant-time compare), the 300s replay window, closed envelope parsing, environment/version fail-closed checks. Signature values are verified as **hex** — this package's single-site decision on the encoding the verified facts leave open (flagged for RL-036). |
| `src/inbox.ts` | `AdcosWebhookInboxService`: durable admission through a `UnitOfWork` (admission log + immutable extended record commit atomically), acknowledgment only after commit, async projection through the `AdcosWebhookProjector` port with deterministic, idempotent reprocessing. |

## Durability model

- The persistence **inbox admission log** owns the dedupe key (the ADCOS
  event id): exactly one `ADMITTED` record per event id, ever. Later
  deliveries become `DUPLICATE` audit rows — visible, never re-effective.
- The **immutable extended record** (raw payload, signature metadata,
  schema version, processing status — exactly the §6 retention set) lives in
  the `adcos-webhook-inbox` records repository and is inserted in the SAME
  unit of work as the admission.
- `REJECTED` audit rows do NOT occupy the dedupe key: a corrected retry of
  the same event id can still be admitted.
- Only the `processing` sub-object ever mutates (`PENDING -> PROJECTED |
  FAILED`, `FAILED -> ...`), guarded by `applyProcessingTransition`
  (immutability + legal-transition enforcement); `PROJECTED` is terminal.

## Authority

ADCOS remains authoritative (RL-LOCK-001/009). Admission proves the event
was authenticatedly delivered, nothing more. The projector port is
implemented by the RL-034 projection engine (bound by the reconciliation/
composition layer — see the handoff notes in the RL-033/034 work items);
this package deliberately depends on neither.

## Test double

`test/fake-adcos-webhooks.ts` signs deliveries with test keys per the v2
contract and provides fault knobs for duplicates, reordering, tampering,
stale timestamps, unknown keys and oversized payloads (spec §10).
