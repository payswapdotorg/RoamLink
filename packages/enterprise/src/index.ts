/**
 * @roamlink/enterprise - the enterprise onboarding/API surface (RL-063).
 *
 * The enterprise customer journey + public API surface:
 *
 *  - ORGANIZATION ENROLLMENT (./enrollment.ts): the journey record with its
 *    own closed state machine (draft -> submitted -> verified -> active /
 *    rejected / cancelled). The organization boundary itself stays owned by
 *    @roamlink/auth - the journey only binds the tenant provisioned through
 *    the registrar port (RL-LOCK-003/019).
 *  - TENANT FEDERATION (./federation.ts): reference-only identity
 *    configuration (protocol + issuer reference + lifecycle). Structurally
 *    incapable of carrying identity material or authenticating anyone.
 *  - ENTERPRISE API KEYS (./api-keys.ts + ./api-key-service.ts): scoped
 *    service authorization through the RL-050 secrets boundary - records
 *    carry typed secret references ONLY; material is generated once,
 *    verified in constant time, rotated by appending secret versions, and
 *    never appears in records, audit events or errors (RL-LOCK-016).
 *  - CONNECTOR PROVISIONING (./connectors.ts): the enterprise side of the
 *    RL-044 edge-connector contract - negotiated capability sets over the
 *    closed vocabulary with the observation + user-guided degradation floor,
 *    plus managed-edge device enrollment records (the landing shape of the
 *    RL-062 capability-snapshot publication).
 *  - ORGANIZATION POLICY READ (./policy.ts): the READ-ONLY organization
 *    policy read record (PA-007, closes RL-115-F7). Organization policy is
 *    enterprise-level configuration managed upstream; this record surfaces
 *    the current observed policy state (configured / not-configured /
 *    unknown with first-class freshness) and deliberately owns NO policy
 *    command or write path - RoamLink never duplicates connectivity policy
 *    authority (RL-LOCK-003/004/005).
 *  - ENTERPRISE INTEGRATION STATUS READ (./integrations.ts): the READ-ONLY
 *    SSO/SCIM/MDM integration status record (PA-008, closes RL-115-F5).
 *    Enterprise integrations are organization-level configuration owned by
 *    the organization's own identity/device infrastructure; this record
 *    surfaces the current observed status of each §8 integration kind with
 *    EXACTLY four honest states (configured / not-configured / unavailable
 *    / unknown - `unavailable` is the missing-backend-contract declaration:
 *    the enterprise integration API exposes no status read for that kind
 *    yet) and deliberately owns NO integration command, OAuth/SCIM/MDM
 *    configuration flow or write path.
 *  - CUSTOMER WEBHOOKS (./webhooks.ts): the RoamLink-side webhook contract -
 *    emitted ONLY from validated RoamLink durable state transitions
 *    (RL-LOCK-009), authenticated with HMAC-SHA256 signatures and replay
 *    protection mirroring the ADCOS inbox discipline.
 *  - THE PUBLIC API SURFACE (./api-surface.ts + ./api-client.ts +
 *    ./api-fake.ts): the typed, versioned, additive-change tolerant
 *    `/v1/enterprise/...` route table, fail-closed wire-resource parsers,
 *    the four-stage mutation acknowledgement mirror, the typed client over
 *    an injectable transport, and a deterministic in-memory fake.
 *
 * Depends on @roamlink/contracts (foundation), @roamlink/secrets (the ONLY
 * way key material enters), @roamlink/audit (onboarding/key security events)
 * and @roamlink/edge-connector (the RL-044 closed vocabularies, used
 * directly - never redefined). No ADCOS imports, no provider mechanics, no
 * domain-authority ownership (RL-LOCK-002/006).
 */
export * from "./version.js";
export * from "./ids.js";
export * from "./enrollment.js";
export * from "./federation.js";
export * from "./api-keys.js";
export * from "./api-key-service.js";
export * from "./connectors.js";
export * from "./policy.js";
export * from "./integrations.js";
export * from "./webhooks.js";
export * from "./onboarding.js";
export * from "./stores.js";
export * from "./api-surface.js";
export * from "./api-client.js";
export * from "./api-fake.js";
