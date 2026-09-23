/**
 * The RoamLink customer application shell (RL-083, ADR-0002).
 *
 * A PRESENTATION boundary only: the shell wraps rendered page bodies with
 * the persistent connectivity status, the desktop sidebar navigation, the
 * mobile bottom navigation and the warm-light, quiet consumer styling from
 * spec/ux-architecture.md §1. It acquires NO domain authority (ADR-0002
 * "the shell is a presentation boundary"), decides NO outcomes, and holds
 * NO local connectivity state machine: the connectivity indicator is a pure
 * DERIVED EXPLANATION computed from the authoritative read model
 * (the parsed ConnectivityOverviewResource subjects), rendered WITH its
 * underlying facts so state is never collapsed into one opaque badge
 * (spec/ux-architecture.md §4, RL-LOCK-010).
 *
 * Honesty rules locked into this module:
 *  - "usefully connected" is claimed ONLY from delivery evidence whose
 *     freshness is FRESH (never from payment, orders, reservations or
 *     webhooks — spec/handoff §8, RL-LOCK-008/009);
 *  - every state is communicated as text + a data attribute + a visual
 *     treatment (never color alone — spec/ux-architecture.md §14);
 *  - an unavailable connectivity read renders the honest
 *     "cannot confirm right now" state, never a guessed status.
 */
import type { SubjectConnectivityResource } from "../api/resources.js";
import { el, fragment, text, type HtmlFragment } from "./html.js";

// --------------------------------------------------------------------------------
// Derived shell connectivity state (a closed vocabulary; a derived EXPLANATION,
// not a new authority: every value is computed only from the read model)
// --------------------------------------------------------------------------------

/**
 * The shell-level connectivity indicator states. Derivation order matters
 * and is tested: fresh delivery evidence wins; stale beats unknown; active
 * references without any delivery evidence are "not delivering yet"; no
 * references at all is "no active reference"; a failed read is honest
 * "cannot confirm".
 */
export const SHELL_CONNECTIVITY_STATES = [
  "evidenced-fresh",
  "evidenced-stale",
  "evidenced-unknown",
  "unevidenced",
  "no-reference",
  "unverifiable",
] as const;
export type ShellConnectivityState = (typeof SHELL_CONNECTIVITY_STATES)[number];

/** Human language for each shell state (text + visual, never color alone). */
export const SHELL_CONNECTIVITY_LANGUAGE: Readonly<
  Record<ShellConnectivityState, { readonly label: string; readonly detail: string }>
> = Object.freeze({
  "evidenced-fresh": {
    label: "Usefully connected",
    detail: "delivery evidence is linked and fresh",
  },
  "evidenced-stale": {
    label: "Delivery evidenced — stale",
    detail: "evidence is linked but its freshness guarantee has expired",
  },
  "evidenced-unknown": {
    label: "Delivery evidenced — freshness unknown",
    detail: "evidence is linked but RoamLink cannot confirm how fresh it is",
  },
  unevidenced: {
    label: "Not delivering yet",
    detail: "there is an active reference but no delivery evidence linked",
  },
  "no-reference": {
    label: "No active connectivity reference",
    detail: "nothing is currently set up to deliver connectivity",
  },
  unverifiable: {
    label: "Cannot confirm right now",
    detail: "the connectivity read is unavailable; this is not a success or a failure claim",
  },
});

/**
 * Derives the shell indicator state from the parsed read-model subjects.
 * Pure + total: any input combination yields exactly one closed-vocabulary
 * value. `null` (a failed/unavailable read) maps to `unverifiable`.
 */
export function deriveShellConnectivityState(
  subjects: readonly SubjectConnectivityResource[] | null,
): ShellConnectivityState {
  if (subjects === null) return "unverifiable";
  if (subjects.length === 0) return "no-reference";
  let sawStale = false;
  let sawUnknown = false;
  for (const subject of subjects) {
    if (subject.deliveryEvidenceState !== "EVIDENCED") continue;
    const freshnessState = subject.evidence?.freshness.freshnessState ?? "UNKNOWN";
    if (freshnessState === "FRESH") return "evidenced-fresh";
    if (freshnessState === "STALE") sawStale = true;
    else sawUnknown = true;
  }
  if (sawStale) return "evidenced-stale";
  if (sawUnknown) return "evidenced-unknown";
  return "unevidenced";
}

function subjectFactLine(subject: SubjectConnectivityResource): HtmlFragment {
  const freshness = subject.evidence?.freshness.freshnessState ?? "no evidence";
  return el(
    "li",
    {},
    fragment(
      text(`${subject.subjectType} ${subject.subjectId}: commercial state ${subject.commercialState}, reference ${subject.referenceStatus}, delivery evidence ${subject.deliveryEvidenceState}, freshness ${freshness}`),
    ),
  );
}

export interface ShellConnectivityIndicatorInput {
  /**
   * The parsed connectivity subjects from the authoritative read model, or
   * `null` when the read failed (renders the honest unverifiable state).
   */
  readonly subjects: readonly SubjectConnectivityResource[] | null;
  /** Where the "Details" link points (the connectivity center). */
  readonly detailsHref: string;
}

/**
 * The persistent connectivity indicator for the global shell. Renders the
 * derived headline WITH the per-subject facts (never one opaque badge), the
 * closed-vocabulary data attribute, `role="status"` for assistive tech, and
 * a details link into the connectivity center.
 */
export function shellConnectivityIndicator(input: ShellConnectivityIndicatorInput): HtmlFragment {
  const state = deriveShellConnectivityState(input.subjects);
  const language = SHELL_CONNECTIVITY_LANGUAGE[state];
  const facts =
    input.subjects === null
      ? fragment(
          el(
            "p",
            { class: "shell-indicator-facts" },
            text("RoamLink could not read the authoritative connectivity state. Nothing is claimed either way."),
          ),
        )
      : input.subjects.length === 0
        ? fragment()
        : el("ul", { class: "shell-indicator-facts" }, ...input.subjects.map(subjectFactLine));
  return el(
    "div",
    {
      class: "shell-indicator",
      "data-shell-connectivity": state,
      role: "status",
    },
    fragment(
      el(
        "p",
        { class: "shell-indicator-headline" },
        fragment(
          el("span", { class: "shell-indicator-mark", "aria-hidden": "true" }, text("●")),
          el("span", { class: "shell-indicator-label" }, text(language.label)),
        ),
      ),
      el("p", { class: "shell-indicator-detail" }, text(language.detail)),
      facts,
      el("a", { class: "shell-indicator-link", href: input.detailsHref }, text("Connectivity details")),
    ),
  );
}

// --------------------------------------------------------------------------------
// Navigation rendering (desktop sidebar + mobile bottom nav)
// --------------------------------------------------------------------------------

export interface ShellNavLink {
  readonly label: string;
  readonly href: string;
}

/**
 * Renders the desktop sidebar navigation (`<nav aria-label="Primary">`).
 * The active destination carries `aria-current="page"` (keyboard/screen-
 * reader visible, never color alone).
 */
export function sidebarNav(
  links: readonly ShellNavLink[],
  activeHref: string | undefined,
): HtmlFragment {
  return el(
    "nav",
    { class: "shell-sidebar-nav", "aria-label": "Primary" },
    el(
      "ul",
      {},
      ...links.map((link) =>
        el(
          "li",
          {},
          el(
            "a",
            {
              href: link.href,
              ...(activeHref !== undefined && link.href === activeHref
                ? { "aria-current": "page" }
                : {}),
            },
            text(link.label),
          ),
        ),
      ),
    ),
  );
}

/**
 * Renders the mobile bottom navigation. Items are full touch targets
 * (44px minimum via the shell stylesheet); the active destination carries
 * `aria-current="page"`.
 */
export function bottomNav(
  items: readonly ShellNavLink[],
  activeHref: string | undefined,
): HtmlFragment {
  return el(
    "nav",
    { class: "shell-bottom-nav", "aria-label": "Primary mobile" },
    el(
      "ul",
      {},
      ...items.map((item) =>
        el(
          "li",
          {},
          el(
            "a",
            {
              href: item.href,
              ...(activeHref !== undefined && item.href === activeHref
                ? { "aria-current": "page" }
                : {}),
            },
            text(item.label),
          ),
        ),
      ),
    ),
  );
}

// --------------------------------------------------------------------------------
// The application shell layout
// --------------------------------------------------------------------------------

export interface ApplicationShellInput {
  readonly appTitle: string;
  /** The shell title links here (Home). */
  readonly homeHref: string;
  /** Desktop sidebar destinations, in the spec §3 order. */
  readonly sidebarLinks: readonly ShellNavLink[];
  /** Mobile bottom-nav destinations, in the spec §3 order. */
  readonly bottomNavItems: readonly ShellNavLink[];
  /** The href of the currently rendered page (drives aria-current). */
  readonly activeHref?: string;
  /** The persistent connectivity indicator fragment. */
  readonly connectivityIndicator: HtmlFragment;
  readonly main: HtmlFragment;
  readonly footerNote: string;
}

/**
 * The full customer shell: skip link → header (title + persistent
 * connectivity status) → sidebar + main → mobile bottom nav → footer.
 * Semantic landmarks only (header/nav/main/aside-free on purpose: the
 * sidebar IS the primary nav), keyboard-visible focus via the stylesheet.
 */
export function applicationShell(input: ApplicationShellInput): HtmlFragment {
  return fragment(
    el("a", { class: "shell-skip-link", href: "#shell-main" }, text("Skip to content")),
    el(
      "header",
      { class: "shell-header" },
      el(
        "div",
        { class: "shell-header-inner" },
        // RL-114-F1 (closed by PA-004): the app title is the DOCUMENT h1 —
        // an h1-wrapped anchor, mirroring the admin shell's siteHeader h1
        // (components.ts pageShell). The anchor keeps its semantics (href +
        // the shell-title class); the wrapper is reset in WARM_SHELL_STYLES
        // (.shell-title-wrap) so the rendered result carries the anchor's
        // size/weight discipline, never the browser's h1 default.
        el(
          "h1",
          { class: "shell-title-wrap" },
          el("a", { class: "shell-title", href: input.homeHref }, text(input.appTitle)),
        ),
        el("div", { class: "shell-header-status" }, input.connectivityIndicator),
      ),
    ),
    el(
      "div",
      { class: "shell-body" },
      el("aside", { class: "shell-sidebar" }, sidebarNav(input.sidebarLinks, input.activeHref)),
      el("main", { id: "shell-main", class: "shell-main" }, input.main),
    ),
    bottomNav(input.bottomNavItems, input.activeHref),
    el(
      "footer",
      { class: "shell-footer" },
      el("div", { class: "shell-footer-inner" }, text(input.footerNote)),
    ),
  );
}

// --------------------------------------------------------------------------------
// The warm-light shell stylesheet
// --------------------------------------------------------------------------------

/**
 * The warm-light, quiet visual system for the customer shell
 * (spec/ux-architecture.md §1): warm neutral palette, generous whitespace,
 * strong typography hierarchy, restrained connected/warning/error colors.
 * State is NEVER color alone: every state also carries text and a data
 * attribute. Motion is guarded by prefers-reduced-motion. Injected through
 * {@link htmlDocument}'s additive `options.styles` parameter.
 */
export const WARM_SHELL_STYLES = `
body { background: #faf8f5; color: #2d2a26; }
.shell-skip-link { position: absolute; left: -999px; top: 0; background: #fff; color: #2d2a26; padding: 0.6rem 1rem; z-index: 10; border: 2px solid #2d2a26; }
.shell-skip-link:focus { left: 0.5rem; top: 0.5rem; }
.shell-header { background: #fffdf9; border-bottom: 1px solid #e8e2da; }
.shell-header-inner { max-width: 72rem; margin: 0 auto; padding: 0.7rem 1.25rem; display: flex; flex-wrap: wrap; gap: 0.6rem 1.5rem; align-items: center; justify-content: space-between; }
.shell-title-wrap { margin: 0; font-size: 1.15rem; font-weight: 700; }
.shell-title { font-size: 1.15rem; font-weight: 700; color: #2d2a26; text-decoration: none; letter-spacing: -0.01em; }
.shell-header-status { min-width: 0; flex: 1 1 16rem; }
.shell-body { max-width: 72rem; margin: 0 auto; padding: 1.25rem; display: block; }
.shell-main { min-width: 0; }
.shell-sidebar { display: none; }
.shell-bottom-nav { display: none; }
.shell-footer { border-top: 1px solid #e8e2da; background: #fffdf9; margin-top: 3rem; }
.shell-footer-inner { max-width: 72rem; margin: 0 auto; padding: 0.8rem 1.25rem; color: #8a8078; font-size: 0.85rem; }
.shell-indicator { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.75rem; }
.shell-indicator-headline { margin: 0; display: flex; align-items: baseline; gap: 0.4rem; }
.shell-indicator-mark { font-size: 0.7rem; }
.shell-indicator-label { font-weight: 600; font-size: 0.92rem; color: #2d2a26; }
.shell-indicator-detail { margin: 0; color: #8a8078; font-size: 0.82rem; }
.shell-indicator-facts { display: none; margin: 0; padding: 0; list-style: none; color: #6f665e; font-size: 0.8rem; }
.shell-indicator[data-expanded-facts="true"] .shell-indicator-facts { display: block; flex-basis: 100%; }
.shell-indicator-link { display: inline-flex; align-items: center; min-height: 44px; font-size: 0.82rem; color: #5f5347; }
.shell-indicator[data-shell-connectivity="evidenced-fresh"] .shell-indicator-mark { color: #1e7a46; }
.shell-indicator[data-shell-connectivity="evidenced-stale"] .shell-indicator-mark { color: #a16207; }
.shell-indicator[data-shell-connectivity="evidenced-unknown"] .shell-indicator-mark,
.shell-indicator[data-shell-connectivity="unverifiable"] .shell-indicator-mark { color: #7a7168; }
.shell-indicator[data-shell-connectivity="unevidenced"] .shell-indicator-mark { color: #a16207; }
.shell-indicator[data-shell-connectivity="no-reference"] .shell-indicator-mark { color: #7a7168; }
@media (min-width: 56rem) {
  .shell-body { display: grid; grid-template-columns: 13rem minmax(0, 1fr); gap: 2.5rem; padding: 1.75rem 1.25rem 3rem; }
  .shell-sidebar { display: block; }
  .shell-sidebar-nav ul { list-style: none; margin: 1.25rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .shell-sidebar-nav a { display: block; padding: 0.5rem 0.75rem; border-radius: 8px; color: #4d453e; text-decoration: none; font-size: 0.95rem; min-height: 44px; box-sizing: border-box; display: flex; align-items: center; }
  .shell-sidebar-nav a:hover { background: #f4efe7; }
  .shell-sidebar-nav a[aria-current="page"] { background: #f1e9dd; color: #2d2a26; font-weight: 600; }
}
@media (max-width: 55.99rem) {
  .shell-bottom-nav { display: block; position: sticky; bottom: 0; background: #fffdf9; border-top: 1px solid #e8e2da; padding-bottom: env(safe-area-inset-bottom, 0); }
  .shell-bottom-nav ul { list-style: none; margin: 0; padding: 0 0.25rem; display: grid; grid-template-columns: repeat(5, 1fr); }
  .shell-bottom-nav a { display: flex; align-items: center; justify-content: center; min-height: 48px; padding: 0.5rem 0.25rem; color: #4d453e; text-decoration: none; font-size: 0.85rem; font-weight: 500; }
  .shell-bottom-nav a[aria-current="page"] { color: #2d2a26; font-weight: 700; box-shadow: inset 0 -3px 0 #b89b72; }
}
:focus-visible { outline: 3px solid #b07f3e; outline-offset: 2px; }
a { color: inherit; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`.trim();
