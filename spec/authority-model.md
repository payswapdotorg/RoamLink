# Authority Model

| Concern | RoamLink | ADCOS | Provider/platform |
|---|---|---|---|
| Customer/user/org identity | **Authoritative** | Reference only | External |
| Device registry/context | **Authoritative for RoamLink device model** | Capability/evidence as exposed | Device OS is authoritative for native facts |
| ExperienceIntent | **Authoritative** | Input | — |
| ConnectivityIntent | Projection/reference only | **Authoritative** | — |
| Eligibility | Request/UX only | **Authoritative** | Provider constraints are evidence |
| Offer | Customer packaging/reference | **Authoritative for ADCOS offer** | Provider inputs |
| Reservation/Lease | Reference | **Authoritative** | Provider may have native reservation state |
| NetworkPath/routing | Never authoritative | **Authoritative** | Underlying network authorities |
| Session | Projection/reference | **Authoritative** | Provider session state is native evidence |
| Mobility | UX/policy intent only | **Authoritative** | Access technology execution |
| Provider registry | Customer metadata only | **Authoritative federation/provider contracts** | Provider own identity |
| Connectivity usage evidence | Read/reference | **Authoritative connectivity evidence** | Raw telemetry/native usage |
| RoamLink customer order | **Authoritative** | Reference | — |
| RoamLink customer payment | **Authoritative** | Reference | Payment rail authoritative for payment transaction |
| ADCOS commercial settlement | Reference | **Authoritative** | Payment rails external |
| Notifications/support | **Authoritative** | Evidence source | — |
| Physical radio/network state | Observation only | Aggregated contract | **Authoritative** |

## Command/observation rule

A RoamLink command may change RoamLink-owned state directly. A command that affects ADCOS-owned state must cross the ADCOS integration boundary and is never implemented by mutating a RoamLink projection.

An observation can update a RoamLink projection without granting RoamLink authority over the observed domain.

## Conflict rule

When RoamLink state conflicts with canonical ADCOS state, the ADCOS-owned field wins for connectivity semantics. When a provider-native fact conflicts with a RoamLink customer label, the provider fact is retained as external evidence and the customer label remains presentation metadata.

## Evidence classes

Use the following minimum evidence labels:

- `AUTHENTICATED`: cryptographically authenticated statement from the authoritative source.
- `OBSERVED`: directly observed by a device/service.
- `REPORTED`: statement reported by another node/service.
- `DERIVED`: deterministically computed from authoritative/observed facts.
- `INFERRED`: heuristic/model-based interpretation; never canonical.
- `STALE`: known prior state whose freshness guarantee has expired.
- `UNKNOWN`: absence or insufficient evidence; not equivalent to failure.
