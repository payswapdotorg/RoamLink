/**
 * ADCOS v2 request header names and typed header records (RL-030).
 *
 * The four v2 headers:
 *  - `X-ADCOS-API-Version`  - the pinned version on EVERY request;
 *  - `X-ADCOS-Application`  - the RoamLink application identity;
 *  - `X-ADCOS-Credential`   - the server-side credential (RL-LOCK-016: never
 *                             logged, never projected, never client-side);
 *  - `X-ADCOS-Idempotency-Key` - REQUIRED on every MUTATION (RL-LOCK-014).
 */
import {
  type AdcosApiVersion,
  type IdempotencyKey,
} from "@roamlink/contracts";

/** The closed set of ADCOS request header names. */
export const ADCOS_REQUEST_HEADER_NAMES = Object.freeze({
  apiVersion: "X-ADCOS-API-Version",
  application: "X-ADCOS-Application",
  credential: "X-ADCOS-Credential",
  idempotencyKey: "X-ADCOS-Idempotency-Key",
});

/**
 * Headers required on EVERY ADCOS request (version pin + application +
 * credential).
 */
export type AdcosRequiredRequestHeaders = {
  readonly [K in typeof ADCOS_REQUEST_HEADER_NAMES.apiVersion]: AdcosApiVersion;
} & {
  readonly [K in typeof ADCOS_REQUEST_HEADER_NAMES.application]: string;
} & {
  readonly [K in typeof ADCOS_REQUEST_HEADER_NAMES.credential]: string;
};

/**
 * Headers required on every ADCOS MUTATION: the required set plus the
 * idempotency key (RL-LOCK-014: retries must not duplicate mutations).
 */
export type AdcosMutationRequestHeaders = AdcosRequiredRequestHeaders & {
  readonly [K in typeof ADCOS_REQUEST_HEADER_NAMES.idempotencyKey]: IdempotencyKey;
};
