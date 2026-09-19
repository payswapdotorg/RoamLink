/**
 * @roamlink/provider-r2 - the object-storage adapter surface (RL-098).
 *
 * Layer: platform provider adapter (leaf). spec/deployment.md §2/§8 +
 * ADR-0003: Cloudflare R2 holds LARGE artifacts (support attachments,
 * diagnostic exports, downloadable reports, large non-relational
 * evidence, encrypted backups) and is NEVER relational authority. The
 * port is a closed blob surface (put/get/delete/list/presign) - no query
 * surface, no relational semantics, bounded admission.
 *
 * Surfaces:
 *  - {@link ObjectStoragePort}: the replaceable storage port;
 *  - {@link InMemoryObjectStorage}: the deterministic fake;
 *  - {@link S3ObjectStorageClient}: the hosted adapter over R2's
 *    S3-compatible API with dependency-free AWS SigV4 (header auth +
 *    presigned query URLs) and a STRICT closed-shape ListObjectsV2 XML
 *    parser;
 *  - {@link buildContentAddressedKey} + `sanitizeObjectFilename`: the
 *    documented key-namespacing conventions (content-addressed,
 *    tenant-scoped, dated);
 *  - {@link tryParseR2Env}: fail-closed, secret-redacting env access;
 *  - {@link createObjectStorageHealthCheck}: observability composition
 *    (a real probe through the port; absence is a valid healthy answer);
 *  - {@link defineObjectStorageContract}: the reusable battery (ADR-0003
 *    replacement rule).
 */
export * from "./port.js";
export * from "./content-address.js";
export * from "./sigv4.js";
export * from "./s3-rest.js";
export * from "./fake.js";
export * from "./env.js";
export * from "./health.js";
export * from "./port-contract.js";
