/**
 * ADCOS v2 pagination (RL-030).
 *
 * The v2 pagination model is `next_cursor`: requests carry an optional
 * `limit` (default 20, max 100), an opaque `cursor` from a previous page,
 * and equality `filters`; list responses carry the page plus the next
 * cursor (null on the last page).
 */
import { ValidationError } from "@roamlink/contracts";

export const ADCOS_PAGINATION_DEFAULT_LIMIT = 20;
export const ADCOS_PAGINATION_MAX_LIMIT = 100;

/** Query parameters accepted by every v2 list route. */
export interface AdcosListQuery {
  /** Page size, 1..100; defaults to 20. */
  readonly limit?: number;
  /** Opaque continuation cursor from a previous page. */
  readonly cursor?: string;
  /** Equality filters (field -> exact value). */
  readonly filters?: Readonly<Record<string, string>>;
}

/** A page of results under the next_cursor model. */
export interface AdcosPage<TPayload> {
  readonly next_cursor: string | null;
  readonly items: readonly TPayload[];
}

export function parseAdcosListQuery(value: unknown): AdcosListQuery {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("AdcosListQuery must be an object", {
      reason: "ADCOS_PAGINATION_INVALID",
      details: [{ path: "AdcosListQuery", issue: "not an object" }],
    });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["limit", "cursor", "filters"].includes(key)) {
      throw new ValidationError(`AdcosListQuery rejected unknown field '${key}'`, {
        reason: "ADCOS_PAGINATION_INVALID",
        details: [{ path: `AdcosListQuery.${key}`, issue: "unknown field" }],
      });
    }
  }
  let limit: number | undefined;
  if (record["limit"] !== undefined) {
    const raw = record["limit"];
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 1 ||
      raw > ADCOS_PAGINATION_MAX_LIMIT
    ) {
      throw new ValidationError(
        `AdcosListQuery.limit must be an integer between 1 and ${ADCOS_PAGINATION_MAX_LIMIT} (ADCOS rejects other values with pagination-invalid)`,
        {
          reason: "ADCOS_PAGINATION_INVALID",
          details: [{ path: "AdcosListQuery.limit", issue: "outside 1..100" }],
        },
      );
    }
    limit = raw;
  }
  let cursor: string | undefined;
  if (record["cursor"] !== undefined) {
    const raw = record["cursor"];
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) {
      throw new ValidationError(
        "AdcosListQuery.cursor must be a non-empty opaque cursor string (max 1024 chars)",
        {
          reason: "ADCOS_PAGINATION_INVALID",
          details: [{ path: "AdcosListQuery.cursor", issue: "not a non-empty string" }],
        },
      );
    }
    cursor = raw;
  }
  let filters: Readonly<Record<string, string>> | undefined;
  if (record["filters"] !== undefined) {
    const raw = record["filters"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidationError("AdcosListQuery.filters must be an object of equality filters", {
        reason: "ADCOS_FILTER_INVALID",
        details: [{ path: "AdcosListQuery.filters", issue: "not an object" }],
      });
    }
    for (const [key, filterValue] of Object.entries(raw)) {
      if (typeof filterValue !== "string") {
        throw new ValidationError(
          `AdcosListQuery.filters values must be strings (equality semantics); field '${key}' is not`,
          {
            reason: "ADCOS_FILTER_INVALID",
            details: [{ path: `AdcosListQuery.filters.${key}`, issue: "not a string" }],
          },
        );
      }
    }
    filters = Object.freeze({ ...(raw as Record<string, string>) });
  }
  const query: AdcosListQuery = {};
  if (limit !== undefined) {
    (query as { limit?: number }).limit = limit;
  }
  if (cursor !== undefined) {
    (query as { cursor?: string }).cursor = cursor;
  }
  if (filters !== undefined) {
    (query as { filters?: Readonly<Record<string, string>> }).filters = filters;
  }
  return query;
}
