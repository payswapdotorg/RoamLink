# RoamLink API Contract

## Customer/experience API

The public RoamLink API is experience-oriented. Representative resources:

- `/v1/users`
- `/v1/organizations`
- `/v1/devices`
- `/v1/experience-intents`
- `/v1/products`
- `/v1/orders`
- `/v1/subscriptions`
- `/v1/payments`
- `/v1/connectivity`
- `/v1/notifications`

Responses expose RoamLink state plus relevant ADCOS references/evidence. They do not expose internal ADCOS implementation types.

## Connectivity read API

A customer may ask, for example, “what connectivity do I currently have?” The response should aggregate authoritative ADCOS projections, device observations and freshness metadata rather than inventing a single opaque status.

## Command semantics

Mutation endpoints return a command/resource acknowledgement. They must clearly distinguish:

`accepted` from `executed`, `executed` from `delivered`, and `delivered` from `billable-final`.

All mutation requests support:

- request ID;
- correlation ID;
- idempotency key;
- actor/tenant context;
- optimistic version when needed.

## Webhooks

RoamLink exposes its own webhook contract to customer integrations. Customer webhooks are emitted from RoamLink's durable state transitions, not directly from unverified ADCOS event payloads.

## API compatibility

Use semantic API versioning. Additive changes are preferred. Breaking changes require explicit versioning, migration notes and contract tests.

## Provider leakage prohibition

Public RoamLink API contracts do not require customers to understand carrier/eSIM/provider-specific mechanics unless the provider-specific detail is explicitly requested as a capability/diagnostic view.
