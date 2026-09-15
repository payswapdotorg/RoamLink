# Mobile and Edge Architecture

## Principle

The mobile/edge client is an observation, experience and synchronization agent, not a radio/network authority.

## Capability discovery

At enrollment the client publishes a signed/versioned capability snapshot describing what the OS and device expose. Capabilities are scoped by platform/version and may expire.

Minimum categories:

- observe active interfaces;
- observe signal/quality metrics allowed by OS;
- Wi-Fi join/control where allowed;
- cellular/eSIM controls where allowed;
- VPN/network extension support;
- background execution;
- push/background notification;
- location permission;
- concurrent-interface support;
- device management/profile installation hooks where enterprise-managed.

## Edge desired-state loop

`local context -> evaluate RoamLink experience policy -> produce desired experience action -> queue command -> server/ADCOS integration -> receive authoritative result -> update local projection`

A local action cannot claim physical success until the appropriate platform/ADCOS evidence is available.

## Offline

While offline the edge:

- continues observation;
- stores bounded telemetry locally;
- records desired-state changes in an encrypted outbox;
- deduplicates retries;
- displays last-known freshness;
- never fabricates connectivity state.

## Device privacy

Permissions are explicit. Collection is purpose-limited, configurable and minimized. Location and network identifiers receive stricter retention and access controls.

## Platform constraints

Implement platform-specific adapters behind a stable edge capability contract. No platform-specific type may leak into Experience/Commerce core packages.

## Enterprise edge

Enterprise deployment may use MDM-managed configuration, system extensions, VPN/network extensions or an enterprise connector when supported. The architecture must still work when only observation and user-guided actions are available.
