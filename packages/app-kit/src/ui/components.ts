/**
 * Shared UI components for the RL-060 customer web app and the RL-061 admin
 * console (app-kit UI layer).
 *
 * Every component is a PURE function from parsed API resources (or typed
 * client errors) to {@link HtmlFragment}s. Rendering rules locked into these
 * components:
 *
 *  - freshness is ALWAYS shown with its state + facts; STALE and UNKNOWN are
 *    visibly distinct and never hidden (RL-LOCK-010, spec/security.md
 *    "Fail-safe defaults");
 *  - the mutation-outcome pipeline renders all FOUR stages separately with
 *    per-stage timestamps - accepted/executed/delivered/billable-final are
 *    never collapsed into one status (spec/api.md "Command semantics");
 *  - connectivity renders the underlying commercial state, reference
 *    lifecycle, delivery-evidence state and evidence freshness side by side -
 *    there is no combined opaque status anywhere (spec/data-model.md
 *    "State separation");
 *  - error panels render contract-borne messages only; unknown errors are
 *    reduced to a generic sentence because third-party error text may carry
 *    credentials (RL-LOCK-016).
 */
import type { ApiClientError } from "../api/errors.js";
import { isApiClientError } from "../api/errors.js";
import type { MutationAcknowledgement } from "../api/outcomes.js";
import { MUTATION_OUTCOME_STAGES } from "../api/outcomes.js";
import type {
  ConnectivityOverviewResource,
  DeviceObservationResource,
  FreshnessView,
  MoneyView,
  SubjectConnectivityResource,
} from "../api/resources.js";
import { el, escapeHtml, fragment, text, type HtmlFragment } from "./html.js";

/** The result of one app-driven mutation flow (success or typed failure). */
export type MutationFlowResult =
  | { readonly status: "ok"; readonly acknowledgement: MutationAcknowledgement }
  | { readonly status: "error"; readonly error: unknown };

// --------------------------------------------------------------------------------
// Primitives
// --------------------------------------------------------------------------------

/** Renders money as integer minor units + code (never floats). */
export function moneyView(money: MoneyView): HtmlFragment {
  const units = Math.trunc(money.amountMinor / 100);
  const minorRest = Math.trunc(money.amountMinor % 100);
  return text(
    `${units}.${minorRest < 10 ? "0" : ""}${minorRest} ${money.currency}`,
  );
}

/** Renders a UTC instant verbatim (explicit zone designator preserved). */
export function instantView(instant: string | null | undefined): HtmlFragment {
  if (instant === null || instant === undefined) {
    return el("span", { class: "muted" }, text("not recorded"));
  }
  return text(instant);
}

/** Renders a freshness record: state + timestamps, never collapsed. */
export function freshnessBadge(
  freshness: FreshnessView | null,
  label?: string,
): HtmlFragment {
  if (freshness === null) {
    return el(
      "span",
      { class: "badge", "data-freshness": "UNKNOWN", title: "no observation recorded" },
      text(label === undefined ? "UNKNOWN" : `${label}: UNKNOWN`),
    );
  }
  const prefix = label === undefined ? freshness.freshnessState : `${label}: ${freshness.freshnessState}`;
  if (freshness.freshnessState === "UNKNOWN") {
    // Unknown is presented, never hidden (RL-LOCK-010): the visible badge says
    // so explicitly rather than relying on a tooltip.
    return el(
      "span",
      {
        class: "badge",
        "data-freshness": "UNKNOWN",
        title: "no usable observation recorded",
      },
      text(`${prefix} (no observation recorded)`),
    );
  }
  const title =
    freshness.freshnessState === "FRESH"
      ? `fresh until ${freshness.freshUntil ?? "no guarantee"}`
      : `freshness guarantee expired (${freshness.freshUntil ?? "no guarantee"})`;
  return el(
    "span",
    {
      class: "badge",
      "data-freshness": freshness.freshnessState,
      title: `${title}; observed ${freshness.observedAt ?? "never"}, received ${freshness.receivedAt ?? "never"}`,
    },
    text(prefix),
  );
}

/** Renders a delivery-evidence state: UNEVIDENCED is explicit, never hidden. */
export function deliveryEvidenceBadge(state: string): HtmlFragment {
  const evidenced = state === "EVIDENCED";
  return el(
    "span",
    {
      class: "badge",
      "data-evidence": evidenced ? "EVIDENCED" : "UNEVIDENCED",
    },
    text(evidenced ? "EVIDENCED" : "UNEVIDENCED"),
  );
}

/** Renders a state badge (any closed vocabulary value). */
export function stateBadge(state: string): HtmlFragment {
  return el("span", { class: "badge", "data-state": state }, text(state));
}

/** Renders a severity badge. */
export function severityBadge(severity: string): HtmlFragment {
  return el("span", { class: "badge", "data-severity": severity }, text(severity));
}

/** Renders a health badge. */
export function healthBadge(health: string): HtmlFragment {
  return el("span", { class: "badge", "data-health": health }, text(health));
}

// --------------------------------------------------------------------------------
// The mutation-outcome pipeline (accepted / executed / delivered / billable-final)
// --------------------------------------------------------------------------------

function stageRow(
  stage: string,
  reachedAt: string | undefined,
  description: string,
): HtmlFragment {
  const reached = reachedAt !== undefined;
  return el(
    "li",
    { "data-stage": stage, "data-reached": reached ? "true" : "false" },
    fragment(
      el("strong", {}, text(stage)),
      text(" - "),
      text(description),
      text(" "),
      reached ? instantView(reachedAt) : el("span", { class: "muted" }, text("(not reached yet)")),
    ),
  );
}

/**
 * Renders the FOUR mutation-outcome stages as separate rows. This component
 * deliberately has no "combined status" mode: collapsing the stages is the
 * exact bug the contract forbids (spec/api.md "Command semantics").
 */
export function mutationStages(ack: MutationAcknowledgement): HtmlFragment {
  return el(
    "ol",
    { class: "stages", "data-command-id": ack.commandId },
    stageRow(
      "accepted",
      ack.acceptedAt,
      "the command was accepted by the boundary",
    ),
    stageRow(
      "executed",
      ack.executedAt,
      "RoamLink applied the command to its own state",
    ),
    stageRow(
      "delivered",
      ack.deliveredAt,
      "delivery evidence was linked for the affected subject",
    ),
    stageRow(
      "billable-final",
      ack.billableFinalAt,
      "commerce finality was reached (e.g. the invoice reconciled)",
    ),
  );
}

/**
 * Renders the result of one mutation flow: the full stage pipeline on
 * success; a typed, safe error panel on failure.
 */
export function mutationResultPanel(result: MutationFlowResult): HtmlFragment {
  if (result.status === "ok") {
    const ack = result.acknowledgement;
    return el(
      "div",
      { class: "panel ok", "data-mutation-result": "ok", "data-command-id": ack.commandId },
      fragment(
        // RL-114-F2 (closed by PA-004): the mutation-result panel heading is
        // a DOCUMENT-BODY-LEVEL heading — it precedes the page's own h2, so
        // it is an h2 under the shell h1 (never an h3 skipping past h2).
        el("h2", {}, text("Command acknowledged")),
        el(
          "p",
          { class: "muted" },
          text(
            `command ${ack.commandId} (idempotency key ${ack.idempotencyKey}, correlation ${ack.correlationId})`,
          ),
        ),
        mutationStages(ack),
      ),
    );
  }
  return errorPanel(result.error);
}

/**
 * Renders a typed error panel. Contract-borne messages (ApiClientError) are
 * shown with their kind/reason/retryability; anything else is reduced to a
 * generic sentence - third-party error text may contain credentials
 * (RL-LOCK-016).
 */
export function errorPanel(error: unknown): HtmlFragment {
  if (isApiClientError(error)) {
    const clientError: ApiClientError = error;
    return el(
      "div",
      {
        class: "panel error",
        "data-mutation-result": "error",
        "data-error-kind": clientError.kind,
        "data-error-reason": clientError.reason,
      },
      fragment(
        // RL-114-F2 (closed by PA-004): document-body-level heading (h2) —
        // see mutationResultPanel above.
        el("h2", {}, text("The request failed")),
        el(
          "p",
          {},
          text(`${clientError.message} (${clientError.kind} / ${clientError.reason})`),
        ),
        clientError.retryable
          ? el("p", { class: "muted" }, text("This failure is retryable."))
          : el("p", { class: "muted" }, text("This failure is not retryable as-is.")),
      ),
    );
  }
  return el(
    "div",
    { class: "panel error", "data-mutation-result": "error", "data-error-kind": "unknown" },
    fragment(
      el("h2", {}, text("The request failed")),
      el(
        "p",
        {},
        text("An unexpected error occurred (details suppressed; see server correlation logs)."),
      ),
    ),
  );
}

/** Loading placeholder. */
export function loadingPanel(what: string): HtmlFragment {
  return el("div", { class: "panel", "data-loading": "true" }, text(`Loading ${what}...`));
}

/** Empty-state placeholder. */
export function emptyState(what: string): HtmlFragment {
  return el(
    "div",
    { class: "panel", "data-empty": "true" },
    text(`No ${what} to show.`),
  );
}

// --------------------------------------------------------------------------------
// Component-scoped degradation (PA-020): the quiet unavailable panel + the
// secondary-read composition helper
// --------------------------------------------------------------------------------

/**
 * The typed marker a page receives when one of its SECONDARY reads refused
 * (PA-020). The marker carries exactly what is known - the typed reason and
 * the contract-borne explanation - and nothing else. It never carries partial
 * data: a section that cannot be composed renders the quiet unavailable
 * panel, never invented content.
 */
export interface UnavailableRead {
  readonly unavailable: true;
  /** The typed reason the source refused (UPPER_SNAKE; rendered verbatim). */
  readonly reason: string;
  /** The contract-borne explanation when the source gave one (safe text). */
  readonly message: string | null;
}

/** A secondary read's outcome: its parsed value, or the typed unavailable marker. */
export type ReadOrUnavailable<T> = T | UnavailableRead;

/** Narrows a {@link ReadOrUnavailable} to its unavailable marker. */
export function isUnavailableRead(value: unknown): value is UnavailableRead {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly unavailable?: unknown }).unavailable === true
  );
}

/**
 * The error kinds that degrade a SECTION (PA-020): the source did not answer.
 *
 *  - `unavailable` - the typed 501 READ_MODEL_NOT_COMPOSED (with its named
 *    reason), 503s and transport failures;
 *  - `not-found` - the source has no such data on this runtime (e.g. the
 *    not-composed enterprise workspace route answers an honest 404);
 *  - `rate-limited` - the source refused this call for now.
 *
 * Everything else stays a PAGE-level fail-closed error: authorization
 * refusals must never render partial surfaces (spec/security.md
 * "Authorization" - never the surface, never partial data), and validation /
 * contract-integrity failures indicate a broken contract that a quiet panel
 * would mask. Those keep the existing honest full-body law.
 */
const SECTION_DEGRADABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "unavailable",
  "not-found",
  "rate-limited",
]);

/**
 * Runs one SECONDARY read fail-soft (PA-020): an unavailability-class typed
 * error becomes the section-level {@link UnavailableRead} marker so the page
 * can render its quiet unavailable panel IN THAT SECTION while its core reads
 * still render. Core reads must NOT go through this helper - a core read
 * failure keeps the page-level fail-closed law (the page has nothing
 * authoritative to say). Non-degradable errors re-throw for exactly that
 * law to catch.
 */
export async function optionalRead<T>(read: () => Promise<T>): Promise<ReadOrUnavailable<T>> {
  try {
    return await read();
  } catch (error) {
    if (isApiClientError(error) && SECTION_DEGRADABLE_ERROR_KINDS.has(error.kind)) {
      return { unavailable: true, reason: error.reason, message: error.message };
    }
    throw error;
  }
}

/** The quiet unavailable panel's input (all fields are known facts). */
export interface UnavailablePanelInput {
  /** The section this panel stands in for (machine key; tests + scanning). */
  readonly section: string;
  /** The typed reason the source refused (rendered verbatim - the WHY). */
  readonly reason: string;
  /** The contract-borne explanation when the source gave one (safe text). */
  readonly message?: string;
  /**
   * One line: what this means here - what is not shown, what IS still known
   * on the page, and where the reader can go next. Written by the page (each
   * section knows its own meaning); never invented by this component.
   */
  readonly meaning: string;
}

/**
 * The quiet unavailable panel (PA-020): a small, section-scoped block in the
 * same calm language as the rest of the shell. It renders ONLY what is known
 * - the title, the typed reason (the WHY) and one what-this-means line. No
 * retry buttons that cannot work, no fake data, no full-page alarm styling.
 */
export function unavailablePanel(input: UnavailablePanelInput): HtmlFragment {
  return el(
    "div",
    {
      class: "panel",
      "data-unavailable": "true",
      "data-unavailable-section": input.section,
      "data-unavailable-reason": input.reason,
    },
    fragment(
      el("h3", {}, text("Not available right now")),
      el(
        "p",
        {},
        fragment(
          text("This section's source did not answer: "),
          el("code", {}, text(input.reason)),
          text("."),
        ),
      ),
      input.message === undefined ? fragment() : el("p", { class: "muted" }, text(input.message)),
      el("p", { class: "muted" }, text(input.meaning)),
    ),
  );
}

/**
 * Renders the quiet unavailable panel from a narrowed {@link UnavailableRead}
 * marker (call this only in the `isUnavailableRead(...)` branch of a
 * secondary read's outcome).
 */
export function unavailablePanelFor(
  outcome: UnavailableRead,
  input: { readonly section: string; readonly meaning: string },
): HtmlFragment {
  return unavailablePanel({
    section: input.section,
    reason: outcome.reason,
    ...(outcome.message !== null ? { message: outcome.message } : {}),
    meaning: input.meaning,
  });
}

// --------------------------------------------------------------------------------
// Connectivity rendering (the honest aggregate)
// --------------------------------------------------------------------------------

function evidenceTable(evidence: SubjectConnectivityResource["evidence"]): HtmlFragment {
  if (evidence === null) {
    return el(
      "p",
      { class: "muted", "data-evidence-present": "false" },
      text("No delivery evidence is linked to this subject."),
    );
  }
  // RL-088: the evidence table renders inside a labelled, keyboard-focusable
  // scroll region (narrow screens scroll, never overflow) and its row
  // headers declare their scope — state is never color- or layout-alone.
  return el(
    "div",
    {
      class: "table-wrap",
      "data-table-wrap": "true",
      role: "region",
      "aria-label": "Delivery evidence facts",
      tabindex: 0,
    },
    el(
      "table",
      { "data-evidence-present": "true" },
      el(
        "tbody",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "row" }, text("Evidence class")),
          el("td", {}, text(evidence.evidenceClass)),
        ),
        el(
          "tr",
          {},
          el("th", { scope: "row" }, text("Canonical resource")),
          el(
            "td",
            {},
            text(`${evidence.canonicalResourceType} / ${evidence.canonicalResourceId}`),
          ),
        ),
        el(
          "tr",
          {},
          el("th", { scope: "row" }, text("Source version")),
          el(
            "td",
            {},
            evidence.sourceVersion === null
              ? el("span", { class: "muted" }, text("not recorded"))
              : text(evidence.sourceVersion),
          ),
        ),
        el(
          "tr",
          {},
          el("th", { scope: "row" }, text("Payload digest")),
          el("td", {}, el("code", {}, text(evidence.payloadDigest))),
        ),
        el(
          "tr",
          {},
          el("th", { scope: "row" }, text("Freshness")),
          el(
            "td",
            {},
            fragment(
              freshnessBadge(evidence.freshness),
              text(" "),
              el(
                "span",
                { class: "muted" },
                text(
                  `observed ${evidence.freshness.observedAt ?? "never"}; recorded as ${evidence.freshness.recordedFreshnessState} when linked`,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Renders ONE commercial subject's connectivity view: commercial state,
 * reference lifecycle, delivery-evidence state and evidence facts side by
 * side. No combined status is produced or implied.
 */
export function connectivitySubjectCard(subject: SubjectConnectivityResource): HtmlFragment {
  return el(
    "section",
    {
      class: "panel",
      "data-subject-type": subject.subjectType,
      "data-subject-id": subject.subjectId,
    },
    fragment(
      el(
        "h3",
        {},
        text(`${subject.subjectType} ${subject.subjectId}`),
      ),
      el(
        "p",
        {},
        fragment(
          text("Commercial state: "),
          stateBadge(subject.commercialState),
          text(" Reference: "),
          stateBadge(subject.referenceStatus),
          text(" Delivery evidence: "),
          deliveryEvidenceBadge(subject.deliveryEvidenceState),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text("These are separate facts about separate authorities; they are not combined."),
      ),
      evidenceTable(subject.evidence),
    ),
  );
}

/** Renders one device's observation freshness (inputs, not truth). */
export function deviceObservationCard(observation: DeviceObservationResource): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-device-id": observation.deviceId },
    fragment(
      el("h3", {}, text(observation.deviceName)),
      el(
        "p",
        {},
        fragment(
          text("Capability snapshot: "),
          freshnessBadge(observation.capabilityFreshness),
          text(" Context snapshot: "),
          freshnessBadge(observation.contextFreshness),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        text(`Last observed: ${observation.lastObservedAt ?? "never"}`),
      ),
    ),
  );
}

/**
 * Renders the full connectivity overview: the per-subject views plus the
 * per-device observations plus the presented-at instant. This is the answer
 * to "what connectivity do I currently have?" - aggregated from projections,
 * observations and freshness metadata, never collapsed
 * (spec/api.md "Connectivity read API").
 */
export function connectivityOverviewSection(overview: ConnectivityOverviewResource): HtmlFragment {
  const cards = [
    ...overview.subjects.map((subject) => connectivitySubjectCard(subject)),
    ...overview.deviceObservations.map((observation) => deviceObservationCard(observation)),
  ];
  return el(
    "section",
    { "data-connectivity-overview": "true", "data-presented-at": overview.presentedAt },
    fragment(
      el(
        "p",
        { class: "muted" },
        text(`Presented at ${overview.presentedAt}. State is aggregated from authoritative projections, device observations and freshness metadata.`),
      ),
      cards.length === 0 ? emptyState("connectivity subjects") : fragment(...cards),
    ),
  );
}

// --------------------------------------------------------------------------------
// Page shell (shared by both apps)
// --------------------------------------------------------------------------------

export interface PageShellInput {
  readonly appTitle: string;
  readonly navLinks: readonly { readonly label: string; readonly href: string }[];
  readonly main: HtmlFragment;
  readonly footerNote: string;
}

/** Renders the page shell with the site header, nav and footer. */
export function pageShell(input: PageShellInput): HtmlFragment {
  return fragment(
    el(
      "header",
      { class: "site" },
      el(
        "div",
        { class: "inner" },
        el("h1", {}, text(input.appTitle)),
        el(
          "nav",
          { class: "tabs" },
          ...input.navLinks.map((link) =>
            el("a", { href: link.href }, text(link.label)),
          ),
        ),
      ),
    ),
    el("main", {}, input.main),
    el(
      "footer",
      { class: "site" },
      el(
        "div",
        { class: "inner" },
        fragment(text(input.footerNote), text(" - "), text(escapeHtml("RoamLink"))),
      ),
    ),
  );
}

// --------------------------------------------------------------------------------
// Re-export of stage vocabulary for test convenience
// --------------------------------------------------------------------------------

export { MUTATION_OUTCOME_STAGES };
