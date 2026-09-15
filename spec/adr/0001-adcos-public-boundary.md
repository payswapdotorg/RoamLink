# ADR-0001: ADCOS Public Integration Boundary

**Status:** Accepted
**Date:** 2026-09-15

## Context

ADCOS already defines authoritative connectivity concerns including intent, eligibility, reservations/leases, paths, sessions, mobility, providers and commercial settlement. Duplicating those authorities inside RoamLink would create conflicting state machines and violate the intended layered architecture.

## Decision

RoamLink integrates with ADCOS only through the ADCOS public Developer API contract. RoamLink owns the customer experience/control domain and maintains projections/references of ADCOS-owned state.

The RoamLink ADCOS module contains the only ADCOS client, mapping, idempotency, webhook admission, projection and reconciliation logic.

RoamLink must not import ADCOS internal implementation packages.

## Consequences

Positive:
- one connectivity authority;
- ADCOS upgrades are isolated behind one boundary;
- workers can develop experience/commerce/edge code in parallel;
- provider and routing details remain outside the customer domain.

Negative:
- some features depend on ADCOS API capabilities;
- projection/reconciliation complexity is required;
- contract compatibility must be tested continuously.

## Rejected alternatives

1. Embed ADCOS internals inside RoamLink — rejected because it duplicates coupling and authority.
2. Reimplement connectivity routing/session logic in RoamLink — rejected because it creates a second connectivity OS.
3. Use a fictional universal `ConnectivityContract` as canonical — rejected; RoamLink maps to the actual ADCOS vocabulary, including ConnectivityIntent, Offer, Reservation/Lease, Session and NetworkPath lifecycle.
