/**
 * In-memory secrets store / fake resolver (RL-050).
 *
 * A complete, deterministic implementation of {@link SecretsResolver} for
 * tests, local development and examples. Rotation semantics:
 *
 *  - `register` creates version 1 (or the explicit `version`) of a name;
 *  - `rotate` appends the next version and makes it ACTIVE - prior versions
 *    remain resolvable (pinned consumers keep working) until retired;
 *  - `retire` makes a NON-ACTIVE version unresolvable (pinned resolution
 *    fails `SECRET_VERSION_RETIRED`); retiring the ACTIVE version is
 *    rejected - rotate first (fail-closed);
 *  - `setUnavailable` simulates a backend outage (`SECRET_UNAVAILABLE`).
 *
 * Values live ONLY inside {@link SecretMaterial} wrappers in memory; the
 * store's metadata views (`describe()`, `activeVersionOf()`) never expose
 * them (RL-LOCK-016).
 */
import { ConflictError, DomainError, ValidationError, parseRevision } from "@roamlink/contracts";

import { SecretMaterial } from "./material.js";
import type { ResolvedSecret } from "./material.js";
import type { SecretsResolver, SecretAccessObserver } from "./resolver.js";
import {
  secretAccessForbiddenError,
  secretUnavailableError,
  secretUnknownError,
  secretVersionRetiredError,
  secretVersionUnknownError,
  withSecretAccessObserver,
} from "./resolver.js";
import type { SecretName, SecretRef, SecretVersion } from "./secret-ref.js";
import { parseSecretName } from "./secret-ref.js";

interface StoredVersion {
  readonly material: SecretMaterial;
  retired: boolean;
}

interface StoredSecret {
  readonly versions: Map<SecretVersion, StoredVersion>;
  active: SecretVersion;
  unavailable: boolean;
}

/** Optional registration knobs for the in-memory store. */
export interface InMemorySecretsOptions {
  /** Value-free access observer (audit wiring); see {@link withSecretAccessObserver}. */
  readonly onAccess?: SecretAccessObserver;
  /**
   * Access guard evaluated before every resolution; return false to fail the
   * resolution with `SECRET_ACCESS_FORBIDDEN` (never sees the value).
   */
  readonly accessGuard?: (ref: SecretRef) => boolean;
}

/** Value-free metadata view of one stored secret. */
export interface SecretMetadataView {
  readonly name: SecretName;
  readonly activeVersion: SecretVersion;
  readonly registeredVersions: readonly SecretVersion[];
  readonly retiredVersions: readonly SecretVersion[];
  readonly unavailable: boolean;
}

export class InMemorySecrets implements SecretsResolver {
  readonly #secrets = new Map<SecretName, StoredSecret>();
  readonly #options: InMemorySecretsOptions;

  constructor(options?: InMemorySecretsOptions) {
    this.#options = options ?? {};
  }

  /**
   * Registers a secret with its initial material. The value is wrapped
   * immediately; a registering caller passes the raw value ONCE at the
   * boundary (mirrors provisioning - production secrets arrive via env or a
   * vault, never via domain code).
   */
  register(name: string, value: string, options?: { readonly version?: number }): SecretVersion {
    const secretName = parseSecretName(name);
    const version: SecretVersion = parseRevision(options?.version ?? 1);
    const material = new SecretMaterial(value); // validates bounds; never stored raw elsewhere
    const existing = this.#secrets.get(secretName);
    if (existing === undefined) {
      const versions = new Map<SecretVersion, StoredVersion>();
      versions.set(version, { material, retired: false });
      this.#secrets.set(secretName, { versions, active: version, unavailable: false });
      return version;
    }
    if (existing.versions.has(version)) {
      throw new ConflictError(
        `secret '${secretName}' already has version ${version}; rotate to append a new version`,
        { reason: "SECRET_VERSION_CONFLICT" },
      );
    }
    if (version !== existing.active + 1) {
      throw new ConflictError(
        `secret '${secretName}' versions are monotonic: register/rotate version ${existing.active + 1} next`,
        { reason: "SECRET_VERSION_CONFLICT" },
      );
    }
    existing.versions.set(version, { material, retired: false });
    existing.active = version;
    return version;
  }

  /** Appends the next version with new material and makes it ACTIVE. */
  rotate(name: string, value: string): SecretVersion {
    const secretName = parseSecretName(name);
    const existing = this.#secrets.get(secretName);
    if (existing === undefined) {
      throw new ConflictError(`secret '${secretName}' is not registered; register it first`, {
        reason: "SECRET_VERSION_CONFLICT",
      });
    }
    const next: SecretVersion = parseRevision(existing.active + 1);
    existing.versions.set(next, { material: new SecretMaterial(value), retired: false });
    existing.active = next;
    existing.unavailable = false; // a successful rotation clears a simulated outage
    return next;
  }

  /** Retires a non-active version; pinned resolution of it fails typed. */
  retire(name: string, version: number): void {
    const secretName = parseSecretName(name);
    const pinnedVersion: SecretVersion = parseRevision(version);
    const existing = this.#secrets.get(secretName);
    if (existing === undefined) {
      throw new ConflictError(`secret '${secretName}' is not registered`, {
        reason: "SECRET_VERSION_CONFLICT",
      });
    }
    const stored = existing.versions.get(pinnedVersion);
    if (stored === undefined) {
      throw new ConflictError(`secret '${secretName}' has no version ${pinnedVersion}`, {
        reason: "SECRET_VERSION_CONFLICT",
      });
    }
    if (pinnedVersion === existing.active) {
      throw new ConflictError(
        `version ${pinnedVersion} is the ACTIVE version of '${secretName}'; rotate before retiring (never leave a secret without an active version)`,
        { reason: "SECRET_ACTIVE_VERSION_RETIRED" },
      );
    }
    stored.retired = true;
  }

  /** Simulates a backend outage: every resolution fails `SECRET_UNAVAILABLE`. */
  setUnavailable(name: string): void {
    const secretName = parseSecretName(name);
    const existing = this.#secrets.get(secretName);
    if (existing === undefined) {
      throw new ConflictError(`secret '${secretName}' is not registered`, {
        reason: "SECRET_VERSION_CONFLICT",
      });
    }
    existing.unavailable = true;
  }

  /** Synchronous active-version read (test/diagnostics convenience). */
  activeVersionOf(name: string): SecretVersion {
    const secretName = parseSecretName(name);
    const existing = this.#secrets.get(secretName);
    if (existing === undefined) {
      throw new ConflictError(`secret '${secretName}' is not registered`, {
        reason: "SECRET_VERSION_CONFLICT",
      });
    }
    return existing.active;
  }

  /** Value-free metadata views of every stored secret (never the material). */
  describe(): readonly SecretMetadataView[] {
    return Object.freeze(
      [...this.#secrets.entries()].map(([name, stored]) =>
        Object.freeze({
          name,
          activeVersion: stored.active,
          registeredVersions: Object.freeze([...stored.versions.keys()].sort((a, b) => a - b)),
          retiredVersions: Object.freeze(
            [...stored.versions.entries()]
              .filter(([, v]) => v.retired)
              .map(([version]) => version)
              .sort((a, b) => a - b),
          ),
          unavailable: stored.unavailable,
        }),
      ),
    );
  }

  async resolve(ref: SecretRef): Promise<ResolvedSecret> {
    if (this.#options.accessGuard !== undefined && !this.#options.accessGuard(ref)) {
      throw secretAccessForbiddenError(ref);
    }
    const stored = this.#secrets.get(ref.name);
    if (stored === undefined) {
      throw secretUnknownError(ref.name);
    }
    if (stored.unavailable) {
      throw secretUnavailableError(ref.name);
    }
    if (ref.version === null) {
      const entry = stored.versions.get(stored.active);
      if (entry === undefined) {
        throw new DomainError("in-memory secrets store invariant violated (active version missing)", {
          reason: "SECRET_STORE_CORRUPT",
        });
      }
      return { name: ref.name, version: stored.active, material: entry.material };
    }
    const entry = stored.versions.get(ref.version);
    if (entry === undefined) {
      throw secretVersionUnknownError(ref.name, ref.version);
    }
    if (entry.retired) {
      throw secretVersionRetiredError(ref);
    }
    return { name: ref.name, version: ref.version, material: entry.material };
  }

  async activeVersion(name: SecretName): Promise<SecretVersion> {
    const stored = this.#secrets.get(name);
    if (stored === undefined) {
      throw secretUnknownError(name);
    }
    if (stored.unavailable) {
      throw secretUnavailableError(name);
    }
    return stored.active;
  }
}

/**
 * Wraps an {@link InMemorySecrets} store (or any resolver) with value-free
 * access observation - the composition used when wiring the RL-051 audit
 * stream to secret accesses.
 */
export function observedInMemorySecrets(options?: InMemorySecretsOptions): SecretsResolver {
  const store = new InMemorySecrets(options);
  if (options?.onAccess === undefined) {
    return store;
  }
  return withSecretAccessObserver(store, options.onAccess);
}

/**
 * Validates that a candidate value could be wrapped as material WITHOUT
 * keeping it: used by provisioning tools that need to pre-check a candidate
 * before handing it to the boundary. The value is never returned or stored.
 */
export function assertSecretValueShape(candidate: unknown): void {
  try {
    new SecretMaterial(candidate as string);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "candidate secret value is not wrappable (bounded non-empty string required; the value is never included)",
        { reason: "SECRET_MATERIAL_INVALID" },
      );
    }
    throw error;
  }
}
