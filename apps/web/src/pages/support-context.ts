/**
 * Contextual support entry points (RL-103, spec/ux-architecture.md §11,
 * spec/user-journey-audit.md §9).
 *
 * Support must be reachable from EVERY degraded/error state, and a support
 * case should automatically carry relevant references where the customer
 * permits it: device; goal; connectivity reference; activity;
 * order/subscription/payment; recent evidence/freshness.
 *
 * This module is the shared carrier for that context:
 *
 *  - {@link SUPPORT_REF_KINDS} - the app-level kind vocabulary the entry
 *    points emit. It is the closed SUPPORT_CASE_RELATED_REF_KINDS vocabulary
 *    (orders/subscriptions/payments/invoices/refunds/connectivity
 *    references/experience intents) plus `device` and `notification`, so
 *    device capability and activity entries can pre-carry their context.
 *  - {@link supportCaseContext} - the typed context bundle an entry point
 *    builds from the read models it already holds.
 *  - {@link supportEscape} - the visible "Get help with this" affordance.
 *    It renders a link to the Support page whose query parameters pre-carry
 *    the context (the host forwards them as page params), plus a
 *    transparency note about what RoamLink will attach.
 *  - {@link supportContextParams} / {@link readSupportContextParams} -
 *    the query-param encoding/decoding pair, so the same context that a
 *    degraded surface emits is what the Support page receives (nothing is
 *    invented in between).
 *  - {@link contextNarrative} - the honest, evidence-linked description
 *    the case carries: recent evidence/freshness facts ride in the case
 *    narrative where no dedicated ref kind exists.
 *
 * The customer decides: the escape always says what will be attached, and
 * the Support page shows the carried context before the case is opened.
 * Customer threads never expose internal-only messages (that boundary
 * stays with the support resource contract).
 */
import { el, fragment, text, type HtmlFragment } from "@roamlink/app-kit";

import { pagePath } from "../routes.js";

/**
 * The app-level related-reference kind vocabulary for support context.
 * CLOSED and additive over the domain vocabulary: every domain kind is
 * spelled identically; `device` and `notification` are the additions the
 * UX spec §11 requests (device; activity) and map 1:1 to the domain
 * SUPPORT_CASE_RELATED_REF_KINDS extension.
 */
export const SUPPORT_REF_KINDS = [
  "order",
  "subscription",
  "payment",
  "invoice",
  "refund",
  "connectivity_reference",
  "experience_intent",
  "device",
  "notification",
] as const;

export type SupportRefKind = (typeof SUPPORT_REF_KINDS)[number];

/** One typed reference pre-carried into a support case. */
export interface SupportRef {
  readonly kind: SupportRefKind;
  readonly id: string;
}

/** The context bundle a degraded surface pre-carries to Support. */
export interface SupportCaseContext {
  /** A human, first-person subject line describing the situation. */
  readonly subject: string;
  /** Optional extra narrative (what the customer was trying to do). */
  readonly detail?: string;
  /** The typed references to carry (kinds from SUPPORT_REF_KINDS). */
  readonly refs: readonly SupportRef[];
}

/**
 * Builds the case description the customer will see before opening the
 * case: the situation, the detail, and the recent evidence/freshness facts
 * phrased honestly (this is how "recent evidence/freshness" travels — as
 * an evidence-linked narrative, never as invented state).
 */
export function contextNarrative(context: SupportCaseContext): string {
  const parts = [context.subject];
  if (context.detail !== undefined && context.detail.length > 0) {
    parts.push(context.detail);
  }
  if (context.refs.length > 0) {
    parts.push(
      `RoamLink will attach these references so support sees what I see: ${context.refs
        .map((ref) => `${ref.kind} ${ref.id}`)
        .join("; ")}.`,
    );
  }
  return parts.join(" ");
}

const MAX_PARAM_LENGTH = 400;

function encodeRef(ref: SupportRef): string {
  return `${ref.kind}~${ref.id}`;
}

function decodeRef(raw: string): SupportRef | null {
  const separator = raw.indexOf("~");
  if (separator <= 0) return null;
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (
    !(SUPPORT_REF_KINDS as readonly string[]).includes(kind) ||
    id.length === 0 ||
    id.length > 200
  ) {
    return null;
  }
  return { kind: kind as SupportRefKind, id };
}

/**
 * Encodes the context into query parameters appended to the Support page
 * path. Refs ride as ONE comma-joined parameter so a host that forwards
 * query params as a plain record loses nothing. Round-trips exactly with
 * {@link readSupportContextParams}.
 */
export function supportContextParams(context: SupportCaseContext): string {
  const params = new URLSearchParams();
  params.set("about", context.subject.slice(0, MAX_PARAM_LENGTH));
  if (context.detail !== undefined && context.detail.length > 0) {
    params.set("detail", context.detail.slice(0, MAX_PARAM_LENGTH));
  }
  if (context.refs.length > 0) {
    params.set("ref", context.refs.map(encodeRef).join(","));
  }
  return params.toString();
}

/**
 * Decodes the Support page's context params back into the typed bundle.
 * Unknown kinds, overlong values and malformed refs are DROPPED (fail-
 * closed decode): the carried context can only ever be a subset of what a
 * degraded surface emitted — never attacker-inflated vocabulary.
 */
export function readSupportContextParams(
  params: Readonly<Record<string, string>> | undefined,
): SupportCaseContext | null {
  if (params === undefined) return null;
  const about = params["about"];
  if (about === undefined || about.length === 0) return null;
  const detail = params["detail"];
  const rawRefs = params["ref"];
  const refs: SupportRef[] = [];
  if (rawRefs !== undefined) {
    for (const raw of rawRefs.split(",")) {
      const ref = decodeRef(raw);
      if (ref !== null && !refs.some((existing) => existing.kind === ref.kind && existing.id === ref.id)) {
        refs.push(ref);
      }
    }
  }
  return {
    subject: about.slice(0, MAX_PARAM_LENGTH),
    ...(detail !== undefined && detail.length > 0 ? { detail: detail.slice(0, MAX_PARAM_LENGTH) } : {}),
    refs,
  };
}

export interface SupportEscapeInput {
  /** The context the case will pre-carry. */
  readonly context: SupportCaseContext;
  /** Override the link label. */
  readonly label?: string;
}

/**
 * The visible escape affordance for one degraded state. Renders the link
 * (with the context encoded in the query string) plus the transparency
 * note listing exactly what RoamLink will attach — the customer decides
 * with full information.
 */
export function supportEscape(input: SupportEscapeInput): HtmlFragment {
  const href = `${pagePath("support")}?${supportContextParams(input.context)}`;
  const carries =
    input.context.refs.length === 0
      ? "no references — just your description"
      : input.context.refs.map((ref) => `${ref.kind} ${ref.id}`).join(", ");
  return el(
    "p",
    { class: "support-escape", "data-support-escape": "true" },
    fragment(
      el("a", { href, "data-support-context": contextNarrative(input.context) }, text(input.label ?? "Get help with this")),
      el(
        "span",
        { class: "muted" },
        text(` Opens Support with: ${carries}. You can remove anything before sending.`),
      ),
    ),
  );
}
