/**
 * The six-level completion vocabulary (PA-021 — THE HONEST-LEVEL LAW).
 *
 * tech-lead-handoff-2026-09-26.md §8 + docs/live-journey-runtime-audit
 * §6: a journey leg's live completeness is not binary. Every leg records
 * WHICH of the six levels it actually EVIDENCED, in this order:
 *
 *   1. route-reachable      the route answered at all (any HTTP status —
 *                           the deployment is up and the route exists);
 *   2. surface-rendered     the expected document rendered (the shell, the
 *                           h1 contract, the page's own markers — INCLUDING
 *                           the honest fail-closed body and the PA-020
 *                           quiet degradation panels: a surface that renders
 *                           its typed refusal or its degraded secondary
 *                           sections HAS rendered);
 *   3. read-available       the page's core data plane composed (real read
 *                           content — an honest empty state IS an available
 *                           read; a page-level typed refusal is NOT);
 *   4. mutation-accepted    a rendered form submitted through the real flow
 *                           plane (/flows/*) and the typed acknowledgement
 *                           panel rendered (command id + idempotency key +
 *                           the four-stage pipeline with `accepted` reached);
 *   5. mutation-executed    the executed stage was evidenced (the ack's
 *                           `executed` row reached, or the command-status
 *                           view showing executedAt);
 *   6. user-visible-evidence the mutation's effect is visible to the user on
 *                           a subsequent surface visit (the resource
 *                           appears in its list/detail read model).
 *
 * THE LAW: a leg that stops at "mutation accepted" PASSES the suite while
 * RECORDING that level — the suite never fails a leg for an honest runtime
 * limitation, and never passes a leg at a level it did not evidence. The
 * exit contract is "no lies", not "everything executed".
 */

export const LEVELS = [
  "route-reachable",
  "surface-rendered",
  "read-available",
  "mutation-accepted",
  "mutation-executed",
  "user-visible-evidence",
] as const;

export type Level = (typeof LEVELS)[number];

/** Human sentences for the report (one line per level). */
export const LEVEL_LANGUAGE: Readonly<Record<Level, string>> = Object.freeze({
  "route-reachable": "the route answered (the deployment is up and the route exists)",
  "surface-rendered":
    "the expected document rendered (shell + h1 contract + page markers; honest fail-closed bodies and PA-020 quiet panels count as rendered surfaces)",
  "read-available":
    "the page's core data plane composed (an honest empty state is an available read; a page-level typed refusal is not)",
  "mutation-accepted":
    "a rendered form submitted through the real /flows/* plane and the typed acknowledgement panel rendered (command id + idempotency key)",
  "mutation-executed": "the executed stage was evidenced on the command's four-stage pipeline",
  "user-visible-evidence": "the mutation's effect is visible on a subsequent surface visit (the read model flipped)",
});

/** The ordinal of a level (0-based; higher = further along the ladder). */
export function levelRank(level: Level): number {
  const index = LEVELS.indexOf(level);
  if (index === -1) throw new Error(`unknown level "${String(level)}" (the six-level vocabulary is closed)`);
  return index;
}

/** The furthest of two levels (the ladder is total). */
export function furthestLevel(a: Level, b: Level): Level {
  return levelRank(a) >= levelRank(b) ? a : b;
}

/** True when `level` is at or beyond `floor` on the ladder. */
export function levelAtLeast(level: Level, floor: Level): boolean {
  return levelRank(level) >= levelRank(floor);
}

/**
 * Parses a level from a string (report round-trips); unknown strings are
 * rejected — the vocabulary is closed, an unknown level in a report is a
 * lie-shaped defect.
 */
export function parseLevel(raw: string): Level {
  const candidate = LEVELS.find((level) => level === raw);
  if (candidate === undefined) {
    throw new Error(`unknown level "${raw}" (the six-level vocabulary is closed)`);
  }
  return candidate;
}
