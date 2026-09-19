/**
 * Shared progressive-disclosure + evidence presentation (RL-102,
 * spec/ux-architecture.md §6 L118-122).
 *
 * The frozen pattern: "Use progressive disclosure: Summary -> Why ->
 * Evidence -> Technical detail" and "A user should be able to understand
 * the situation without opening Technical detail."
 *
 * This module is the SHARED builder for that pattern. It preserves the
 * exact `data-disclosure="why|evidence|technical"` vocabulary the
 * Connectivity Center introduced (RL-084) so every surface that shows
 * evidence speaks the same disclosure language:
 *
 *  - {@link DISCLOSURE_LAYERS} - the closed layer vocabulary;
 *  - {@link disclosureSection} - one `<details data-disclosure="...">`
 *    section with a human summary heading;
 *  - {@link evidenceDisclosure} - the Evidence layer for delivery-evidence
 *    subjects: per-subject evidence facts with freshness, and the honest
 *    absence statement when nothing is linked (nothing is invented);
 *  - {@link technicalDisclosure} - the Technical detail layer: record
 *    identifiers only, always with the "you never need this" framing;
 *  - {@link disclosureFactRow} - the shared `dt/dd` fact row.
 *
 * HONESTY RULES locked here (RL-LOCK-009/010):
 *  - every evidence claim renders WITH its source facts (class, canonical
 *    record, timestamps, freshness) - a claim never detaches from its
 *    evidence;
 *  - freshness stays the honest closed set (FRESH/STALE/UNKNOWN) from the
 *    parsed read model - never re-derived, never guessed;
 *  - absence renders honestly ("no delivery evidence is linked yet") - the
 *    disclosure layers never invent facts the read model does not carry.
 */
import type { SubjectConnectivityResource } from "../api/resources.js";
import { el, fragment, text, type HtmlFragment } from "./html.js";
import { freshnessBadge } from "./components.js";

/**
 * The closed disclosure-layer vocabulary (spec/ux-architecture.md §6):
 * the exact `data-disclosure` values the customer surface speaks.
 */
export const DISCLOSURE_LAYERS = ["why", "evidence", "technical"] as const;

export type DisclosureLayer = (typeof DISCLOSURE_LAYERS)[number];

export interface DisclosureSectionInput {
  /** Which disclosure layer this is (the data-disclosure value). */
  readonly layer: DisclosureLayer;
  /** The human summary heading inside `<summary>` (visible when closed). */
  readonly summary: string;
  /** Optional lead-in paragraph rendered first inside the open section. */
  readonly intro?: string;
  /** The layer's body content. */
  readonly body: HtmlFragment;
  /** Extra attributes merged onto the `<details>` element. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Renders one progressive-disclosure section: a native `<details>` element
 * carrying the closed `data-disclosure` vocabulary. The summary stays
 * readable when closed, so a user can understand the situation without
 * opening deeper layers - and Technical detail is never required.
 */
export function disclosureSection(input: DisclosureSectionInput): HtmlFragment {
  return el(
    "details",
    {
      class: "disclosure",
      "data-disclosure": input.layer,
      ...(input.attributes ?? {}),
    },
    fragment(
      el("summary", {}, text(input.summary)),
      input.intro === undefined
        ? fragment()
        : el("p", { class: "muted" }, text(input.intro)),
      input.body,
    ),
  );
}

/** The shared definition-list fact row (`dt`/`dd`). */
export function disclosureFactRow(label: string, value: string | number): HtmlFragment {
  return el(
    "div",
    { class: "fact-row" },
    el("dt", {}, text(label)),
    el("dd", {}, text(value)),
  );
}

/** The honest absence statement for a subject without linked evidence. */
export const NO_EVIDENCE_LINKED_SENTENCE =
  "No delivery evidence is linked to this reference yet. When the network confirms delivery, the evidence and its freshness appear here.";

function evidenceSubjectPanel(subject: SubjectConnectivityResource): HtmlFragment {
  if (subject.evidence === null) {
    return el(
      "section",
      { class: "panel", "data-evidence-subject": subject.subjectId },
      fragment(
        el("h4", {}, text(`${subject.subjectType} ${subject.subjectId}`)),
        el(
          "p",
          { class: "muted", "data-evidence-present": "false" },
          text(NO_EVIDENCE_LINKED_SENTENCE),
        ),
      ),
    );
  }
  const freshness = subject.evidence.freshness;
  return el(
    "section",
    { class: "panel", "data-evidence-subject": subject.subjectId, "data-evidence-present": "true" },
    fragment(
      el("h4", {}, text(`${subject.subjectType} ${subject.subjectId}`)),
      el(
        "dl",
        { class: "fact-list" },
        disclosureFactRow("Evidence class", subject.evidence.evidenceClass),
        disclosureFactRow("Kind of evidence record", subject.evidence.canonicalResourceType),
        disclosureFactRow("Evidence record id", subject.evidence.canonicalResourceId),
        disclosureFactRow("Observed", freshness.observedAt ?? "never"),
        disclosureFactRow("Received", freshness.receivedAt ?? "never"),
        disclosureFactRow("Freshness guarantee until", freshness.freshUntil ?? "(no guarantee recorded)"),
        disclosureFactRow("Freshness when linked", freshness.recordedFreshnessState),
      ),
    ),
  );
}

export interface EvidenceDisclosureInput {
  /** The connectivity subjects whose linked evidence renders here. */
  readonly subjects: readonly SubjectConnectivityResource[];
  /** Override the default summary heading. */
  readonly summary?: string;
  /** Extra attributes merged onto the `<details>` element. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * The Evidence layer for delivery-evidence subjects. Every claim is linked
 * to its source (class + canonical record id + timestamps + freshness,
 * verbatim from the parsed read model); subjects without evidence render
 * the honest absence state. Never invents facts.
 */
export function evidenceDisclosure(input: EvidenceDisclosureInput): HtmlFragment {
  const panels = input.subjects.map(evidenceSubjectPanel);
  return disclosureSection({
    layer: "evidence",
    summary: input.summary ?? "Evidence",
    body:
      panels.length === 0
        ? el(
            "p",
            { class: "muted" },
            text("No connectivity references exist yet, so there is no evidence to show."),
          )
        : fragment(...panels),
    ...(input.attributes ?? {}),
  });
}

function technicalSubjectPanel(subject: SubjectConnectivityResource): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-technical-subject": subject.subjectId },
    fragment(
      el("h4", {}, text(`${subject.subjectType} ${subject.subjectId}`)),
      subject.evidence === null
        ? el("p", { class: "muted" }, text("No evidence record is linked yet."))
        : el(
            "dl",
            { class: "fact-list" },
            disclosureFactRow("Evidence class", subject.evidence.evidenceClass),
            disclosureFactRow("Canonical resource type", subject.evidence.canonicalResourceType),
            disclosureFactRow("Canonical resource id", subject.evidence.canonicalResourceId),
            disclosureFactRow(
              "Source version",
              subject.evidence.sourceVersion === null
                ? "not recorded"
                : subject.evidence.sourceVersion,
            ),
            disclosureFactRow("Causing event id", subject.evidence.eventId ?? "not recorded"),
            el(
              "div",
              { class: "fact-row" },
              el("dt", {}, text("Payload digest")),
              el("dd", {}, el("code", {}, text(subject.evidence.payloadDigest))),
            ),
          ),
    ),
  );
}

export interface TechnicalDisclosureInput {
  /** The connectivity subjects whose record identifiers render here. */
  readonly subjects: readonly SubjectConnectivityResource[];
  /** Extra attributes merged onto the `<details>` element. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * The Technical detail layer: record identifiers for the delivery evidence.
 * Always framed with the frozen rule that this section is never needed to
 * understand the connection (spec/ux-architecture.md §6).
 */
export function technicalDisclosure(input: TechnicalDisclosureInput): HtmlFragment {
  const panels = input.subjects.map(technicalSubjectPanel);
  return disclosureSection({
    layer: "technical",
    summary: "Technical detail",
    intro:
      "Record identifiers for the delivery evidence. You never need this section to understand your connection.",
    body:
      panels.length === 0
        ? el("p", { class: "muted" }, text("Nothing to show yet."))
        : fragment(...panels),
    ...(input.attributes ?? {}),
  });
}

/**
 * A compact evidence-freshness line for surfaces that show one subject's
 * freshness inline (activity entries, capability cards): the freshness
 * badge plus its honest label - never a re-derived state.
 */
export function evidenceFreshnessLine(
  subject: Pick<SubjectConnectivityResource, "evidence">,
): HtmlFragment {
  if (subject.evidence === null) {
    return el(
      "span",
      { class: "muted", "data-evidence-freshness": "none" },
      text("no delivery evidence linked"),
    );
  }
  return el(
    "span",
    {
      "data-evidence-freshness": subject.evidence.freshness.freshnessState,
    },
    fragment(
      freshnessBadge(subject.evidence.freshness),
      text(" (freshness of the linked delivery evidence)"),
    ),
  );
}
