/**
 * The mobile shell's views (RL-062).
 *
 * Framework-free, typed, XSS-safe HTML rendering on the app-kit core -
 * every screen is a PURE function from the shell's read models (or an
 * already-parsed API resource) to an {@link HtmlFragment}. The honesty
 * rules are structural (spec/mobile.md; RL-LOCK-010/011/015):
 *
 *  - FRESHNESS IS ALWAYS RENDERED: every state row carries a freshness badge
 *    (FRESH / STALE / UNKNOWN) with its observed instant; absence of
 *    evidence renders as UNKNOWN, never as healthy (spec/security.md
 *    "Fail-safe defaults");
 *  - DEGRADED CONTROLS RENDER OBSERVATION + MANUAL GUIDANCE: a blocked
 *    action renders the gate's closed-vocabulary reason plus the
 *    platform-appropriate manual guidance text - the control never fakes
 *    success and never hides WHY it is unavailable;
 *  - QUEUED IS NOT EXECUTED: outbox rows render the sync-boundary state and
 *    the honest "queued != executed" markers;
 *  - the offline banner renders LAST-KNOWN state - the shell never
 *    fabricates connectivity.
 *
 * PA-005 (RL-114 F5/F6/F7 - the mobile accessibility/navigation closure)
 * adds the document-level contracts the customer web shell already has
 * (spec/ux-architecture.md §14):
 *
 *  - F5: every edge document carries the a11y layer - a skip link to the
 *    main landmark, a :focus-visible contract, a prefers-reduced-motion
 *    guard, a 44px touch-target floor on every interactive family, and the
 *    env(safe-area-inset-*) contract on the labelled bottom navigation
 *    (the same four legs, now the spec §1 "mobile bottom navigation"
 *    pattern through app-kit's bottomNav);
 *  - F6: every screen renders its nav-fragment target id, so the four
 *    shell anchors (#now/#capabilities/#controls/#outbox) resolve in any
 *    composition that renders the screens (the hosted composition pattern
 *    - tests/e2e/test/hosted-offline-edge-enterprise.test.ts);
 *  - F7: every table header cell declares its scope and every table sits
 *    inside a labelled, keyboard-focusable scroll region (the web shell's
 *    .table-wrap contract).
 */
import {
  freshnessBadge,
  stateBadge,
  htmlDocument,
  bottomNav,
} from "@roamlink/app-kit";
import { fragment, el, text, type FreshnessView, type HtmlFragment } from "@roamlink/app-kit";

import type { MobileCapabilityRow, MobileConnectivityView, MobileActionResult } from "./shell.js";
import type { MobileEnrollmentPublication } from "./enrollment.js";
import type { EdgeOutboxRecord } from "@roamlink/edge";
import type { DeviceActionProjectionEntry } from "@roamlink/edge-actions";

/** The shell contract version (mirror of the edge discipline). */
export { MOBILE_SHELL_CONTRACT_VERSION } from "./enrollment.js";

const NAV = [
  { label: "Now", href: "#now" },
  { label: "Capabilities", href: "#capabilities" },
  { label: "Controls", href: "#controls" },
  { label: "Outbox", href: "#outbox" },
] as const;

/** The id of the main landmark every edge document's skip link targets (RL-114-F5). */
export const MOBILE_MAIN_CONTENT_ID = "main-content";

/**
 * The mobile/edge document stylesheet additions (PA-005, RL-114 F5/F7),
 * layered on app-kit's base document styles through htmlDocument's
 * `options.styles` - the same discipline as the customer web shell's
 * WARM_SHELL_STYLES/WEB_APP_STYLES:
 *
 *  - the skip link (visually hidden until focused);
 *  - the keyboard-visible focus contract (:focus-visible outlines);
 *  - the reduced-motion guard (spec §14 "reduced-motion behavior");
 *  - the 44px touch-target floor on every interactive family (the bottom
 *    navigation links and the skip link itself);
 *  - the env(safe-area-inset-*) contract: the bottom navigation pads its
 *    home-indicator/landscape insets and the header pads the top inset;
 *  - the .table-wrap labelled scroll region styling (RL-114-F7).
 */
export const MOBILE_EDGE_STYLES = `
.skip-link { position: absolute; left: -999px; top: 0; background: #fffdf9; color: #2d2a26; padding: 0.6rem 1rem; z-index: 10; border: 2px solid #2d2a26; min-height: 44px; box-sizing: border-box; display: inline-flex; align-items: center; }
.skip-link:focus { left: 0.5rem; top: 0.5rem; }
:focus-visible { outline: 3px solid #b07f3e; outline-offset: 2px; }
header.site { padding-top: env(safe-area-inset-top, 0); }
.shell-bottom-nav { position: sticky; bottom: 0; background: #fffdf9; border-top: 1px solid #e8e2da; padding: 0 env(safe-area-inset-right, 0) env(safe-area-inset-bottom, 0) env(safe-area-inset-left, 0); }
.shell-bottom-nav ul { list-style: none; margin: 0; padding: 0 0.25rem; display: grid; grid-template-columns: repeat(4, 1fr); }
.shell-bottom-nav a { display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0.5rem 0.25rem; color: #4d453e; text-decoration: none; font-size: 0.85rem; font-weight: 500; }
.shell-bottom-nav a:hover { color: #2d2a26; }
.table-wrap { overflow-x: auto; margin: 0.5rem 0 1rem; -webkit-overflow-scrolling: touch; }
.table-wrap table { margin: 0; }
.table-wrap:focus-visible { outline: 3px solid #b07f3e; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`.trim();

/** Renders the full mobile document (a host renders this into a WebView). */
export function mobileDocument(title: string, body: HtmlFragment): string {
  return htmlDocument(
    `RoamLink Edge - ${title}`,
    fragment(
      // RL-114-F5: the skip link is the document's first focusable element.
      el("a", { class: "skip-link", href: `#${MOBILE_MAIN_CONTENT_ID}` }, text("Skip to content")),
      el(
        "header",
        { class: "site" },
        el("div", { class: "inner" }, el("h1", {}, text("RoamLink Edge"))),
      ),
      el("main", { id: MOBILE_MAIN_CONTENT_ID }, body),
      // RL-114-F5/F7: the labelled bottom navigation - the same four legs
      // (Now/Capabilities/Controls/Outbox) through app-kit's bottomNav
      // (nav[aria-label] > ul > li > a, full touch targets via the styles).
      // No aria-current: hosts compose the documents and own which leg is
      // on screen; the shell renders all four fragment destinations.
      bottomNav([...NAV], undefined),
      el(
        "footer",
        { class: "site" },
        el(
          "div",
          { class: "inner" },
          text(
            "RoamLink mobile/edge shell (RL-062): an observation, experience and synchronization agent - never a network authority. - RoamLink",
          ),
        ),
      ),
    ),
    { styles: [MOBILE_EDGE_STYLES] },
  ).html;
}

/** The offline/online banner: last-known state, never fabricated. */
export function reachabilityBanner(view: MobileConnectivityView): HtmlFragment {
  const observed = view.observedConnectivityState;
  return fragment(
    el(
      "p",
      { class: "muted" },
      text(
        view.syncReachable
          ? "Sync: reachable (queued commands will converge)"
          : "Offline - observation continues; queued commands are held in the encrypted outbox",
      ),
    ),
    el(
      "p",
      {},
      text("Connectivity (last observed): "),
      observed === null
        ? freshnessBadge(null, "connectivity") // renders UNKNOWN explicitly
        : fragment(
            el("strong", {}, text(observed.value)),
            text(" "),
            freshnessBadge(observed.freshness),
          ),
    ),
  );
}

/**
 * Wraps one table in the labelled, keyboard-focusable scroll region
 * (RL-114-F7): narrow screens scroll inside the region, never overflow,
 * and the region is announced by its aria-label.
 */
function tableRegion(label: string, table: HtmlFragment): HtmlFragment {
  return el(
    "div",
    {
      class: "table-wrap",
      "data-table-wrap": "true",
      role: "region",
      "aria-label": label,
      tabindex: 0,
    },
    table,
  );
}

/** The "connectivity now" screen: observed context + freshness, always. */
export function connectivityScreen(view: MobileConnectivityView): HtmlFragment {
  const rows = view.context.map((entry) =>
    el(
      "tr",
      {},
      el("td", {}, text(entry.field)),
      el("td", {}, text(entry.value)),
      el("td", {}, freshnessBadge(entry.freshness)),
    ),
  );
  return fragment(
    el("h2", { id: "now" }, text("Connectivity now")),
    reachabilityBanner(view),
    el(
      "p",
      { class: "muted" },
      text(
        view.lastObservationAt === null
          ? "No observations yet - everything below is honestly unknown."
          : `Last observation cycle: ${view.lastObservationAt}`,
      ),
    ),
    tableRegion(
      "Connectivity context observations",
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { scope: "col" }, text("Context")),
            el("th", { scope: "col" }, text("Value")),
            el("th", { scope: "col" }, text("Freshness")),
          ),
        ),
        el("tbody", {}, ...(rows.length === 0 ? [el("tr", {}, el("td", { colspan: 3 }, text("no observations yet")))] : rows)),
      ),
    ),
    el("p", {}, text("Outbox: "), text(`${view.outbox.pending} pending, ${view.outbox.synced} synced, ${view.outbox.deadLettered} dead-lettered`)),
  );
}

/** The enrollment screen: the signed, versioned, expiring publication. */
export function enrollmentScreen(
  publication: MobileEnrollmentPublication,
  freshness: FreshnessView | null,
): HtmlFragment {
  return fragment(
    el("h2", {}, text("Enrollment")),
    el(
      "p",
      {},
      text("Published capability snapshot "),
      el("strong", {}, text(`#${publication.snapshot.sequence}`)),
      text(" - signed ("),
      text(publication.signature.algorithm),
      text(", key "),
      text(publication.signature.keyId),
      text(")"),
    ),
    el("p", {}, text("Digest: "), el("code", {}, text(publication.snapshotDigest))),
    freshnessBadge(freshness),
  );
}

/**
 * The capability matrix screen: the truth table - status, evidence class,
 * freshness and the gate preview per capability (RL-LOCK-011 rendered).
 */
export function capabilityMatrixScreen(rows: readonly MobileCapabilityRow[]): HtmlFragment {
  const body = rows.map((row) =>
    el(
      "tr",
      {},
      el("td", {}, text(row.capability)),
      el("td", {}, stateBadge(row.status)),
      el("td", {}, text(row.evidenceClass)),
      el("td", {}, freshnessBadge(row.freshness)),
      el(
        "td",
        {},
        row.gatePreview.admission === "ADMITTED"
          ? text("allow")
          : text(`${row.gatePreview.gate.decision} (${row.gatePreview.gate.reason})`),
      ),
    ),
  );
  return fragment(
    el("h2", { id: "capabilities" }, text("Capabilities")),
    el("p", { class: "muted" }, text("Evidence-based: controls only unlock with real platform evidence.")),
    tableRegion(
      "Device capability truth table",
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { scope: "col" }, text("Capability")),
            el("th", { scope: "col" }, text("Status")),
            el("th", { scope: "col" }, text("Evidence")),
            el("th", { scope: "col" }, text("Freshness")),
            el("th", { scope: "col" }, text("Gate now")),
          ),
        ),
        el("tbody", {}, ...(body.length === 0 ? [el("tr", {}, el("td", { colspan: 5 }, text("no snapshot yet")))] : body)),
      ),
    ),
  );
}

/** The manual guidance text for a blocked or degraded control (closed map). */
export function manualGuidanceFor(reason: string, capability: string): string {
  switch (reason) {
    case "capability-requires-permission":
      return `Grant the ${capability.replace(/_/g, " ")} permission in the platform privacy settings, then re-run the capability probe.`;
    case "capability-unavailable":
      return `The platform reports ${capability.replace(/_/g, " ")} as unavailable on this device - use the platform's own settings app to manage it manually.`;
    case "capability-unknown":
      return `No evidence yet for ${capability.replace(/_/g, " ")} - observation will fill this in; nothing is assumed.`;
    case "evidence-class-insufficient":
      return `The evidence backing ${capability.replace(/_/g, " ")} is too weak to act on - refresh the observation.`;
    case "evidence-stale":
      return `The ${capability.replace(/_/g, " ")} observation is stale - re-run the probe before acting.`;
    case "action-unsupported":
      return `This action has no platform implementation on this device - perform it manually via the platform settings.`;
    default:
      return "Observation continues; manual guidance: use the platform's own controls.";
  }
}

/** The controls screen after a requested action: the honest outcome. */
export function actionOutcomeScreen(
  outcome: MobileActionResult,
  capability: string,
  guidanceFor: (reason: string, capability: string) => string = manualGuidanceFor,
): HtmlFragment {
  const result = outcome.result;
  const blocked = outcome.outcome === "BLOCKED";
  const reason = result.reason;
  return fragment(
    el("h2", { id: "controls" }, text("Controls")),
    el("h3", {}, text(outcome.mode === "local" ? "Local action" : "Server-bound desired state")),
    el(
      "p",
      {},
      text("Outcome: "),
      stateBadge(result.status),
    ),
    el("p", {}, text(`Completed at: ${result.completedAt}`)),
    outcome.mode === "server"
      ? el(
          "p",
          { class: "muted" },
          text(
            outcome.outcome === "QUEUED"
              ? "Queued into the encrypted offline outbox - queued is NOT executed; the authoritative result arrives through sync."
              : outcome.outcome === "ALREADY_QUEUED"
                ? "Already queued (idempotent re-request)."
                : "Not queued.",
          ),
        )
      : fragment(),
    reason === undefined
      ? fragment()
      : el(
          "div",
          { class: "guidance" },
          el("strong", {}, text("Manual guidance: ")),
          text(guidanceFor(reason, capability)),
        ),
    blocked
      ? el("p", { class: "muted" }, text("The control stays disabled until the platform exposes it - the shell never fakes success."))
      : fragment(),
  );
}

/** The outbox screen: queued commands with their honest boundary states. */
export function outboxScreen(records: readonly EdgeOutboxRecord[]): HtmlFragment {
  const rows = records.map((record) =>
    el(
      "tr",
      {},
      el("td", {}, text(record.actionDedupeKey)),
      el("td", {}, stateBadge(record.state)),
      el("td", {}, text(`${record.attempts}/${record.retryPolicy.maxAttempts}`)),
      el("td", {}, freshnessBadge(record.lastKnownFreshness)),
    ),
  );
  return fragment(
    el("h2", { id: "outbox" }, text("Encrypted offline outbox")),
    el("p", { class: "muted" }, text("Payloads are ciphertext-only at rest; identity/dedupe metadata stays in the clear.")),
    tableRegion(
      "Encrypted outbox records",
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { scope: "col" }, text("Action")),
            el("th", { scope: "col" }, text("State")),
            el("th", { scope: "col" }, text("Attempts")),
            el("th", { scope: "col" }, text("Freshness")),
          ),
        ),
        el("tbody", {}, ...(rows.length === 0 ? [el("tr", {}, el("td", { colspan: 4 }, text("empty")))] : rows)),
      ),
    ),
  );
}

/** The action-history screen: local projection entries with sync boundaries. */
export function actionHistoryScreen(entries: readonly DeviceActionProjectionEntry[]): HtmlFragment {
  const rows = entries.map((entry) =>
    el(
      "tr",
      {},
      el("td", {}, text(entry.capability)),
      el("td", {}, entry.latestResult === null ? text("no result yet") : stateBadge(entry.latestResult.status)),
      el("td", {}, entry.syncBoundary === null ? text("local only") : stateBadge(entry.syncBoundary)),
      el("td", {}, text(entry.latestResultSource ?? "-")),
    ),
  );
  return fragment(
    el("h2", {}, text("Action history")),
    el("p", { class: "muted" }, text("synced means the server ACCEPTED the command - physical success only ever comes from platform/ADCOS evidence.")),
    tableRegion(
      "Action history entries",
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { scope: "col" }, text("Capability")),
            el("th", { scope: "col" }, text("Latest result")),
            el("th", { scope: "col" }, text("Sync boundary")),
            el("th", { scope: "col" }, text("Source")),
          ),
        ),
        el("tbody", {}, ...(rows.length === 0 ? [el("tr", {}, el("td", { colspan: 4 }, text("no actions yet")))] : rows)),
      ),
    ),
  );
}
