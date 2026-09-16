/**
 * The projection store port + deterministic in-memory adapter (RL-034).
 *
 * The WRITE surface (`ProjectionWriter`) is the integration boundary's
 * alone: only the projection engine (driven by webhook projection and
 * canonical refresh) may write ADCOS-derived projections (spec §8: "Only
 * the reconciler/integration boundary may write ADCOS-derived projections").
 * Everyone else consumes the READ surface (`ProjectionReader`).
 *
 * Writes are optimistic-concurrency guarded: `apply(record,
 * expectedProjectionVersion)` swaps atomically and throws the typed Wave-0
 * ConflictError on a lost race - never a silent overwrite (RL-LOCK-014
 * spirit). The in-memory adapter runs in tests/CI; a persistence-backed
 * adapter implements the same port later (spec/repository-layout.md
 * runtime baseline - infrastructure choices swap behind contracts).
 */
import { ConflictError } from "@roamlink/contracts";
import {
  parseAdcosProjectionRecord,
  projectionIdFor,
  type AdcosProjectionRecord,
  type AdcosProjectionResourceType,
} from "./projection-record.js";

/** The integration-boundary-only write surface. */
export interface ProjectionWriter {
  /**
   * Atomically applies a projection at the expected version. The FIRST
   * write of a record uses `expectedProjectionVersion: null`. A mismatch
   * (or an unexpected first write) throws the typed ConflictError.
   */
  apply(
    record: AdcosProjectionRecord,
    expectedProjectionVersion: number | null,
  ): Promise<AdcosProjectionRecord>;
}

/** The everyone-else read surface (committed projections only). */
export interface ProjectionReader {
  get(
    resourceType: AdcosProjectionResourceType,
    resourceId: string,
  ): Promise<AdcosProjectionRecord | null>;
  list(resourceType?: AdcosProjectionResourceType): Promise<readonly AdcosProjectionRecord[]>;
  count(resourceType?: AdcosProjectionResourceType): Promise<number>;
}

export type ProjectionStore = ProjectionWriter & ProjectionReader;

/**
 * The deterministic in-memory projection store. Keyed by the deterministic
 * projection identity; records are validated through the closed §8 parser
 * on every read and write.
 */
export class InMemoryProjectionStore implements ProjectionStore {
  readonly #records = new Map<string, AdcosProjectionRecord>();

  async apply(
    record: AdcosProjectionRecord,
    expectedProjectionVersion: number | null,
  ): Promise<AdcosProjectionRecord> {
    const validated = parseAdcosProjectionRecord(record);
    const key = validated.projection_id;
    const current = this.#records.get(key);
    if (expectedProjectionVersion === null) {
      if (current !== undefined) {
        throw new ConflictError(
          "projection first-write conflict: the projection already exists; re-read and apply at the stored version",
          { reason: "PROJECTION_WRITE_CONFLICT" },
        );
      }
    } else {
      if (current === undefined) {
        throw new ConflictError(
          "projection compare-and-swap conflict: the projection does not exist (it was deleted concurrently, or never existed)",
          { reason: "PROJECTION_WRITE_CONFLICT" },
        );
      }
      if (current.projection_version !== expectedProjectionVersion) {
        throw new ConflictError(
          "projection compare-and-swap conflict: the stored projection version does not match the expected version; re-read and retry - never overwrite silently",
          { reason: "PROJECTION_WRITE_CONFLICT" },
        );
      }
    }
    if (current !== undefined && validated.projection_version !== current.projection_version + 1) {
      throw new ConflictError(
        "projection apply must advance the projection version by exactly one",
        { reason: "PROJECTION_WRITE_CONFLICT" },
      );
    }
    if (current === undefined && validated.projection_version !== 1) {
      throw new ConflictError(
        "the first projection of a record must be at projection_version 1",
        { reason: "PROJECTION_WRITE_CONFLICT" },
      );
    }
    this.#records.set(key, Object.freeze({ ...validated }));
    return Object.freeze({ ...validated });
  }

  async get(
    resourceType: AdcosProjectionResourceType,
    resourceId: string,
  ): Promise<AdcosProjectionRecord | null> {
    const record = this.#records.get(projectionIdFor(resourceType, resourceId));
    return record === undefined ? null : Object.freeze({ ...record });
  }

  async list(
    resourceType?: AdcosProjectionResourceType,
  ): Promise<readonly AdcosProjectionRecord[]> {
    const all = [...this.#records.values()];
    const filtered =
      resourceType === undefined
        ? all
        : all.filter((record) => record.canonical_resource_type === resourceType);
    return Object.freeze(
      [...filtered].sort((a, b) => (a.projection_id < b.projection_id ? -1 : a.projection_id > b.projection_id ? 1 : 0)),
    );
  }

  async count(resourceType?: AdcosProjectionResourceType): Promise<number> {
    return (await this.list(resourceType)).length;
  }
}
