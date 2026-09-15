# Data Model

## Domain aggregates

### Experience
- `User`
- `Organization`
- `Membership`
- `Device`
- `DeviceCapabilitySnapshot`
- `DeviceContextSnapshot`
- `ExperienceIntent`
- `ExperienceIntentVersion`
- `ExperienceDecision`
- `Notification`

### Commerce
- `Product`
- `ProductVariant`
- `Order`
- `OrderLine`
- `Subscription`
- `CustomerPayment`
- `CustomerInvoice`
- `CustomerRefund`

### ADCOS references/projections
- `AdcosIntentRef`
- `AdcosOfferProjection`
- `AdcosReservationProjection`
- `AdcosSessionProjection`
- `AdcosPathProjection`
- `AdcosUsageProjection`
- `AdcosCommercialProjection`
- `AdcosWebhookInbox`
- `AdcosReconciliationJob`

## Identity rules

RoamLink IDs are opaque, globally unique identifiers. They are never reused for ADCOS NodeID, session ID, path ID or provider IDs. Foreign/canonical IDs are stored in explicitly named reference fields.

## Versioning

Mutable customer state is versioned using monotonic revisions or optimistic concurrency tokens. Experience intents are immutable versions linked by a supersession chain. Projections retain source version/event identity.

## State separation

Never collapse these into one enum:

`customer_payment_state`
`order_state`
`experience_intent_state`
`adcos_reservation_state`
`adcos_session_state`
`delivery_evidence_state`
`customer_subscription_state`

A derived customer status may combine them only as a read model and must expose the underlying states/evidence.

## Multi-tenancy

Every tenant-scoped aggregate carries an organization/customer boundary where applicable. Cross-tenant references are prohibited unless an explicit federation/service contract permits them.

## Time and freshness

All persisted timestamps are UTC instants with explicit serialization. Any state derived from remote systems has `observed_at`, `received_at` and freshness semantics.

## Privacy

Device telemetry is minimized. Location, network identifiers, diagnostics and usage data have explicit purpose/retention classifications. Secrets and credentials are never persisted in ordinary domain tables.
