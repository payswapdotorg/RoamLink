# ADCOS Integration Contract

## 1. Dependency rule

RoamLink integrates with ADCOS through one bounded context. The implementation must target the ADCOS **public Developer API contract**, not ADCOS internal modules.

The integration layer must isolate ADCOS version/protocol changes from the rest of RoamLink.

## 2. Canonical lifecycle used by RoamLink

RoamLink must model the relevant ADCOS lifecycle without inventing a replacement:

`ConnectivityIntent -> Offer/eligibility -> Reservation/Lease -> SessionAuthorized -> PathActive -> DeliveryStarted -> Usage -> BILLABLE_FINAL -> settlement`

RoamLink may expose a simplified customer lifecycle, but every simplified state must retain a mapping to the underlying ADCOS canonical state and evidence.

## 3. Requests

Supported integration operations are contract-driven and should cover, as supported by the installed ADCOS Developer API version:

- create/read ConnectivityIntent;
- discover/read Offers;
- create/read Reservation;
- read lifecycle state;
- read usage;
- read billing/commercial references;
- subscribe/admit webhooks;
- reconcile canonical resources.

RoamLink must not call undocumented/internal ADCOS endpoints.

## 4. Intent compilation

`ExperienceIntentCompiler` performs:

1. schema validation;
2. policy normalization;
3. hard/soft constraint classification;
4. privacy/service constraint mapping;
5. validity-window calculation;
6. deterministic canonical serialization;
7. digest generation;
8. ADCOS ConnectivityIntent command creation.

The compiler must preserve the source ExperienceIntent ID and version for traceability.

## 5. Idempotency

Every externally mutating command has:

- RoamLink command ID;
- correlation ID;
- idempotency key;
- actor/tenant ID;
- intent/order version;
- creation timestamp;
- retry metadata.

An integration retry must be safe after timeout, connection loss or duplicate delivery.

## 6. Webhook inbox

Inbound ADCOS events are processed as:

`receive -> authenticate -> replay check -> persist immutable inbox record -> acknowledge/admit -> async project -> canonical refresh when needed`

The inbox record retains raw contract payload or a secure content reference, event ID, source, timestamp, signature metadata, schema version and processing status.

Reprocessing must be deterministic and idempotent.

## 7. Reconciliation

The reconciler periodically compares projection freshness against canonical ADCOS resources. It must repair:

- missed webhooks;
- duplicate webhooks;
- out-of-order events;
- stale projections;
- partially applied projections;
- transient ADCOS/API failures.

When canonical truth cannot be obtained, the state becomes `STALE` or `UNKNOWN`; the system does not guess.

## 8. Projection contract

Projection records include:

```text
projection_id
source_authority
canonical_resource_type
canonical_resource_id
source_version/event_id
payload_digest
observed_at
received_at
fresh_until
freshness_state
evidence_class
projection_version
``` 

Only the reconciler/integration boundary may write ADCOS-derived projections.

## 9. Compatibility gate

The supported ADCOS contract version is configured in one place. Startup/integration tests must verify:

- endpoint/schema availability;
- required lifecycle states;
- required fields/enums;
- signature/webhook semantics;
- idempotency behavior;
- version compatibility.

Incompatible ADCOS versions fail closed for mutations and expose a diagnosable health state.

## 10. Test double

The local ADCOS fake must implement the same public integration interface as the real client. It must simulate duplicates, reordering, delayed events, dropped events, transient failures and canonical-state changes.

No test may depend on ADCOS internal implementation classes.
