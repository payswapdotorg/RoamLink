/**
 * Enrollment publication contract (RL-062, spec/mobile.md "Capability
 * discovery").
 *
 * "At enrollment the client publishes a signed/versioned capability
 * snapshot describing what the OS and device expose. Capabilities are
 * scoped by platform/version and may expire."
 *
 * A {@link MobileEnrollmentPublication} therefore carries:
 *
 *  - the SIGNED capability snapshot (the RL-040 record verbatim - this
 *    package reuses it, never redefines it);
 *  - its canonical SHA-256 digest (tamper-evident: any snapshot field change
 *    changes the digest and breaks the signature);
 *  - the SIGNATURE: an HMAC over the digest produced through the injectable
 *    {@link MobileEnrollmentSigner} port. The signing KEY never enters the
 *    shell - production binds a platform secure-enclave/device-attestation
 *    adapter, tests bind a deterministic fake (RL-LOCK-016);
 *  - VERSIONING: the publication is sequence-numbered on the device's
 *    snapshot chain and contract-versioned (additive-tolerant, RL-LOCK-017);
 *  - EXPIRY: the publication inherits the snapshot's `freshUntil` and
 *    freshness is RE-EVALUATED at every read (an expired publication renders
 *    as STALE, never as missing or fresh - RL-LOCK-010).
 */
import {
  ValidationError,
  canonicalJsonDigest,
  makeFreshness,
  parseUtcInstant,
  refreshFreshnessState,
  type ContractVersion,
  type Freshness,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  EdgeCapabilitySnapshot,
  type EdgeCapabilitySnapshotPlain,
} from "@roamlink/edge";

/** The mobile shell contract version (mirror of the edge discipline). */
export const MOBILE_SHELL_CONTRACT_VERSION = "0.1" as const;

/** The signature algorithm label carried by publications. */
export const MOBILE_ENROLLMENT_SIGNATURE_ALGORITHM = "hmac-sha256";

/** Safe-label grammar for the signer's key reference. */
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/**
 * The enrollment signing port. Production binds a platform
 * secure-enclave/attestation adapter; the shell never holds key material
 * (RL-LOCK-016). The signature covers the canonical snapshot digest.
 */
export interface MobileEnrollmentSigner {
  /** Bounded, printable algorithm label (diagnostics). */
  readonly algorithm: string;
  /** Key REFERENCE (never material). */
  readonly keyId: string;
  /** Signs a message (the snapshot digest); returns a hex signature. */
  sign(message: string): Promise<string>;
  /** Verifies a signature over a message (tests + server-side checks). */
  verify(message: string, signature: string): Promise<boolean>;
}

/** The signature block of a publication (public data, never key material). */
export interface MobileEnrollmentSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly value: string;
}

/** Serialized (plain) form of an enrollment publication. */
export interface MobileEnrollmentPublication {
  readonly publicationId: string;
  readonly contractVersion: ContractVersion;
  readonly deviceRef: string;
  readonly platform: { readonly family: string; readonly platformVersion: string };
  /** The published capability snapshot (the RL-040 record verbatim). */
  readonly snapshot: EdgeCapabilitySnapshotPlain;
  /** Canonical SHA-256 digest of the snapshot (tamper-evidence). */
  readonly snapshotDigest: string;
  readonly signature: MobileEnrollmentSignature;
  readonly publishedAt: UtcInstant;
  /** The publication's expiry, inherited from the snapshot. */
  readonly freshUntil: UtcInstant | null;
  /** Freshness re-evaluated at the query instant (RL-LOCK-010). */
  readonly freshness: Freshness;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{64,128}$/;

function publicationField(label: string, issue: string): never {
  throw new ValidationError(`MobileEnrollmentPublication rejected: ${label} - ${issue}`, {
    reason: "MOBILE_ENROLLMENT_PUBLICATION_INVALID",
    details: [{ path: label, issue }],
  });
}

/**
 * Builds the signed enrollment publication for a capability snapshot. The
 * signature covers the snapshot digest; the publication keeps the snapshot
 * verbatim so receivers can recompute the digest and verify.
 */
export async function buildMobileEnrollmentPublication(
  input: {
    readonly publicationId: string;
    readonly snapshot: EdgeCapabilitySnapshot | EdgeCapabilitySnapshotPlain;
  },
  signer: MobileEnrollmentSigner,
  at: UtcInstant | string,
): Promise<MobileEnrollmentPublication> {
  const instant = parseUtcInstant(at);
  // The snapshot may arrive as the frozen class or its plain form; both carry
  // exactly the contract fields, and the digest is (re)computed canonically.
  const snapshot: EdgeCapabilitySnapshotPlain =
    input.snapshot instanceof EdgeCapabilitySnapshot
      ? input.snapshot.toPlain()
      : (input.snapshot as EdgeCapabilitySnapshotPlain);
  const digest = canonicalJsonDigest(snapshot);
  if (typeof digest !== "string" || !HEX_64.test(digest)) {
    publicationField("snapshotDigest", "the snapshot must carry its canonical SHA-256 digest");
  }
  const signature = await signer.sign(digest);
  if (typeof signature !== "string" || !HEX_SIGNATURE.test(signature)) {
    publicationField("signature", "the signer must return a hex signature");
  }
  if (typeof input.publicationId !== "string" || input.publicationId.length === 0) {
    publicationField("publicationId", "must be a non-empty identifier");
  }
  return Object.freeze({
    publicationId: input.publicationId,
    contractVersion: snapshot.contractVersion,
    deviceRef: snapshot.deviceRef,
    platform: snapshot.platform,
    snapshot,
    snapshotDigest: digest,
    signature: Object.freeze({
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      value: signature,
    }),
    publishedAt: instant,
    freshUntil: snapshot.freshUntil,
    freshness: makeFreshness(
      {
        observedAt: snapshot.observedAt,
        receivedAt: instant,
        freshUntil: snapshot.freshUntil,
      },
      instant,
    ),
  });
}

/**
 * Verifies a publication end-to-end: the signature must verify over the
 * snapshot digest AND the digest must match the snapshot's own canonical
 * digest (tamper-evidence). Freshness is reported honestly, never guessed.
 */
export async function verifyMobileEnrollmentPublication(
  publication: MobileEnrollmentPublication,
  signer: MobileEnrollmentSigner,
): Promise<boolean> {
  if (publication.signature.algorithm !== signer.algorithm) return false;
  if (publication.signature.keyId !== signer.keyId) return false;
  const snapshot = publication.snapshot;
  const recomputed = canonicalJsonDigest(snapshot);
  if (recomputed !== publication.snapshotDigest) return false;
  return signer.verify(publication.snapshotDigest, publication.signature.value);
}

/** True when the signer's key id is a safe label (constructor guard). */
export function isSafeMobileKeyRef(keyId: unknown): keyId is string {
  return typeof keyId === "string" && KEY_ID_PATTERN.test(keyId);
}

/** Re-evaluates a publication's freshness at `at` (STALE degrades monotonically). */
export function publicationFreshnessAt(
  publication: MobileEnrollmentPublication,
  at: UtcInstant | string,
): Freshness {
  return refreshFreshnessState(publication.freshness, parseUtcInstant(at));
}
