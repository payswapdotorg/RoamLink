/**
 * Application-shell component tests (RL-083, ADR-0002).
 *
 * The shell is a presentation boundary, so these tests lock the presentation
 * contract itself:
 *  - the derived connectivity indicator NEVER claims success without fresh
 *     delivery evidence and always shows its underlying facts;
 *  - the shell renders the desktop sidebar + mobile bottom navigation with
 *     aria-current and semantic landmarks;
 *  - state is communicated as text + data attributes (never color alone);
 *  - the warm-light stylesheet carries the a11y rules (focus-visible,
 *     reduced-motion, 44px touch targets, safe-area inset).
 */
import { describe, expect, it } from "vitest";

import type { SubjectConnectivityResource } from "../src/index.js";
import {
  applicationShell,
  bottomNav,
  deriveShellConnectivityState,
  el,
  htmlDocument,
  SHELL_CONNECTIVITY_LANGUAGE,
  SHELL_CONNECTIVITY_STATES,
  shellConnectivityIndicator,
  sidebarNav,
  text,
  WARM_SHELL_STYLES,
  type ShellConnectivityState,
} from "../src/index.js";

function subject(input: Partial<SubjectConnectivityResource>): SubjectConnectivityResource {
  return {
    subjectType: "subscription",
    subjectId: "88888888-0000-4000-8000-000000000001",
    commercialState: "active",
    referenceStatus: "active",
    deliveryEvidenceState: "UNEVIDENCED",
    evidence: null,
    ...input,
  };
}

const FRESH_EVIDENCE = {
  evidenceClass: "AUTHENTICATED_WEBHOOK",
  canonicalResourceType: "connectivity_contract" as const,
  canonicalResourceId: "ctr_1",
  sourceVersion: 1,
  eventId: "evt_1",
  payloadDigest: "a".repeat(64),
  freshness: {
    observedAt: "2025-01-06T09:00:00.000Z",
    receivedAt: "2025-01-06T09:00:05.000Z",
    freshUntil: "2025-01-06T10:00:00.000Z",
    freshnessState: "FRESH" as const,
    recordedFreshnessState: "FRESH" as const,
  },
};

const NAV_LINKS = [
  { label: "Home", href: "/" },
  { label: "Connectivity", href: "/connectivity" },
  { label: "Activity", href: "/activity" },
];

describe("deriveShellConnectivityState (the honest aggregate)", () => {
  it("maps every input combination into the closed vocabulary", () => {
    expect(SHELL_CONNECTIVITY_STATES).toEqual([
      "evidenced-fresh",
      "evidenced-stale",
      "evidenced-unknown",
      "unevidenced",
      "no-reference",
      "unverifiable",
    ]);
    expect(deriveShellConnectivityState(null)).toBe("unverifiable");
    expect(deriveShellConnectivityState([])).toBe("no-reference");
    expect(
      deriveShellConnectivityState([subject({ deliveryEvidenceState: "UNEVIDENCED" })]),
    ).toBe("unevidenced");
  });

  it("claims 'usefully connected' ONLY from fresh delivery evidence", () => {
    const fresh = deriveShellConnectivityState([
      subject({ deliveryEvidenceState: "EVIDENCED", evidence: FRESH_EVIDENCE }),
    ]);
    expect(fresh).toBe("evidenced-fresh");
    // A succeeded payment/reservation-like commercial state NEVER produces it.
    const paidButUnevidenced = deriveShellConnectivityState([
      subject({ commercialState: "active", deliveryEvidenceState: "UNEVIDENCED" }),
    ]);
    expect(paidButUnevidenced).toBe("unevidenced");
    expect(paidButUnevidenced).not.toBe("evidenced-fresh");
  });

  it("ranks stale above unknown among evidenced subjects", () => {
    const stale = deriveShellConnectivityState([
      subject({
        deliveryEvidenceState: "EVIDENCED",
        evidence: {
          ...FRESH_EVIDENCE,
          freshness: { ...FRESH_EVIDENCE.freshness, freshnessState: "STALE" as const },
        },
      }),
    ]);
    expect(stale).toBe("evidenced-stale");
    const unknown = deriveShellConnectivityState([
      subject({
        deliveryEvidenceState: "EVIDENCED",
        evidence: {
          ...FRESH_EVIDENCE,
          freshness: { ...FRESH_EVIDENCE.freshness, freshnessState: "UNKNOWN" as const },
        },
      }),
    ]);
    expect(unknown).toBe("evidenced-unknown");
    // Mixed: fresh wins over stale and unknown.
    const mixed = deriveShellConnectivityState([
      subject({
        deliveryEvidenceState: "EVIDENCED",
        evidence: {
          ...FRESH_EVIDENCE,
          freshness: { ...FRESH_EVIDENCE.freshness, freshnessState: "STALE" as const },
        },
      }),
      subject({ subjectId: "s2", deliveryEvidenceState: "EVIDENCED", evidence: FRESH_EVIDENCE }),
    ]);
    expect(mixed).toBe("evidenced-fresh");
  });

  it("an evidenced subject without an evidence payload cannot claim fresh", () => {
    const state = deriveShellConnectivityState([
      subject({ deliveryEvidenceState: "EVIDENCED", evidence: null }),
    ]);
    expect(state).toBe("evidenced-unknown");
  });

  it("every state has human language (never color alone)", () => {
    for (const state of SHELL_CONNECTIVITY_STATES) {
      const language = SHELL_CONNECTIVITY_LANGUAGE[state as ShellConnectivityState];
      expect(language.label.length).toBeGreaterThan(0);
      expect(language.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("shellConnectivityIndicator", () => {
  it("renders the derived state with data attribute, role=status and its facts", () => {
    const html = shellConnectivityIndicator({
      subjects: [
        subject({ deliveryEvidenceState: "EVIDENCED", evidence: FRESH_EVIDENCE }),
        subject({ subjectId: "s2", deliveryEvidenceState: "UNEVIDENCED" }),
      ],
      detailsHref: "/connectivity",
    }).html;
    expect(html).toContain('data-shell-connectivity="evidenced-fresh"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Usefully connected");
    // The underlying facts stay visible, not collapsed:
    expect(html).toContain("commercial state active");
    expect(html).toContain("delivery evidence UNEVIDENCED");
    expect(html).toContain('href="/connectivity"');
  });

  it("a failed read renders the honest unverifiable state, never a guess", () => {
    const html = shellConnectivityIndicator({ subjects: null, detailsHref: "/connectivity" }).html;
    expect(html).toContain('data-shell-connectivity="unverifiable"');
    expect(html).toContain("Cannot confirm right now");
    expect(html).not.toContain("Usefully connected");
  });

  it("the unevidenced state never says connected", () => {
    const html = shellConnectivityIndicator({
      subjects: [subject({})],
      detailsHref: "/connectivity",
    }).html;
    expect(html).toContain('data-shell-connectivity="unevidenced"');
    expect(html).toContain("Not delivering yet");
    expect(html).toContain("no delivery evidence linked");
  });

  it("escapes subject ids (XSS-safe by structure)", () => {
    const html = shellConnectivityIndicator({
      subjects: [subject({ subjectId: '<script>alert(1)</script>' })],
      detailsHref: "/connectivity",
    }).html;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("navigation rendering", () => {
  it("the sidebar nav is the primary landmark with aria-current on the active link", () => {
    const html = sidebarNav(NAV_LINKS, "/connectivity").html;
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('href="/connectivity" aria-current="page"');
    expect(html).not.toContain('href="/" aria-current="page"');
    expect(html).toContain("Home");
  });

  it("the bottom nav labels itself as the mobile primary nav", () => {
    const html = bottomNav(NAV_LINKS, "/activity").html;
    expect(html).toContain('aria-label="Primary mobile"');
    expect(html).toContain('href="/activity" aria-current="page"');
  });
});

describe("applicationShell layout", () => {
  const shell = applicationShell({
    appTitle: "RoamLink",
    homeHref: "/",
    sidebarLinks: NAV_LINKS,
    bottomNavItems: NAV_LINKS,
    activeHref: "/",
    connectivityIndicator: shellConnectivityIndicator({ subjects: [], detailsHref: "/connectivity" }),
    main: el("p", {}, text("Page body")),
    footerNote: "The shell is a presentation boundary.",
  });

  it("renders the semantic landmark structure", () => {
    const html = shell.html;
    expect(html).toContain('<header class="shell-header"');
    expect(html).toContain("<main");
    expect(html).toContain('id="shell-main"');
    expect(html).toContain("<footer");
    expect(html).toContain("Page body");
  });

  it("has a keyboard skip link to the main landmark", () => {
    const html = shell.html;
    expect(html).toContain('class="shell-skip-link" href="#shell-main"');
    expect(html).toContain("Skip to content");
  });

  it("renders the title as a link to Home and carries the persistent indicator", () => {
    const html = shell.html;
    expect(html).toContain('class="shell-title" href="/"');
    expect(html).toContain("shell-indicator");
    expect(html).toContain('data-shell-connectivity="no-reference"');
  });

  it("the footer stays a plain presentation note", () => {
    expect(shell.html).toContain("The shell is a presentation boundary.");
  });

  it("the full document wraps the shell with the warm-light styles appended", () => {
    const document = htmlDocument("RoamLink", shell, { styles: [WARM_SHELL_STYLES] });
    const html = document.html;
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain(":focus-visible");
    // Minimum touch targets + mobile safe-area handling:
    expect(html).toContain("min-height: 48px");
    expect(html).toContain("env(safe-area-inset-bottom");
    // Warm-light palette is present:
    expect(html).toContain("#faf8f5");
  });

  it("documents without options stay byte-identical in structure (additive change)", () => {
    const before = htmlDocument("RoamLink", shell);
    expect(before.html).toContain("<!DOCTYPE html>");
    expect(before.html).not.toContain("prefers-reduced-motion");
  });
});
