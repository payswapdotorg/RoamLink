# Security Architecture

## Trust zones

1. Public client/device.
2. RoamLink edge agent.
3. RoamLink API/control plane.
4. RoamLink persistence/queue systems.
5. ADCOS integration boundary.
6. ADCOS external authority.
7. Provider/payment systems.

No zone implicitly trusts another.

## Credential rules

- Customer sessions use RoamLink authentication and scoped authorization.
- Service-to-service ADCOS credentials remain server-side.
- Edge credentials are short-lived, device-bound where possible, narrowly scoped and revocable.
- Provider/payment credentials are isolated by integration and tenant.
- Secrets are injected through the runtime secret mechanism and excluded from logs/config committed to the repository.

## Webhooks

Require source authentication/signature verification, replay protection, event ID deduplication, schema validation, payload-size limits and durable inbox admission.

## Authorization

Every mutation checks tenant boundary, actor permissions, resource ownership and command idempotency before touching state. Integration commands are authorized independently from customer UX permissions.

## Audit

Record security-relevant mutations with actor, tenant, command, correlation ID, target resource, authorization decision, timestamp and outcome. Never log secrets or full sensitive payloads unnecessarily.

## Threat priorities

- forged/replayed ADCOS webhooks;
- confused-deputy cross-tenant commands;
- stale projection causing unsafe customer action;
- duplicated reservation/order/payment commands;
- leaked ADCOS/provider credentials;
- compromised edge device;
- malicious provider metadata;
- dependency/SDK supply-chain compromise;
- loss/reordering of offline commands;
- privilege escalation through support/administrative tooling.

## Fail-safe defaults

Unknown or unverifiable connectivity state must not be represented as healthy. Unsupported device control must degrade to observation/manual guidance. Incompatible ADCOS contracts fail closed for state-changing operations.
