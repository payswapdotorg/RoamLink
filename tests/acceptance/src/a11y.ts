/**
 * The a11y/interaction battery (PA-021 §3.3) — run on every walked page.
 *
 * Asserts the interaction contract of spec/ux-architecture.md §14 and the
 * repo's own verified floor set (apps/web/test/rl114-extended-a11y.test.ts):
 *
 *  - exactly one h1 per document (the shell-title contract);
 *  - no heading-level skips (the hierarchy starts at h1 and deepens by at
 *    most one level at a time);
 *  - the skip link on application-shell pages (a.shell-skip-link[href="#shell-main"]);
 *  - the mobile bottom nav present (and displayed, layout-gated) at mobile
 *    width; the desktop sidebar at desktop width;
 *  - the 44px touch-target floor over the VERIFIED selector families;
 *  - keyboard reachability: a tab-order sample whose stops are visible;
 *  - focus visibility on the sampled keyboard stops;
 *  - forms submittable via keyboard (evidenced by the journeys themselves —
 *    the login and onboarding-goal submissions go through Enter when the
 *    driver has a keyboard; recorded per context, not re-driven here).
 *
 * Capability honesty: structural checks run on every driver; the
 * layout/keyboard checks record NAMED SKIPS on the offline fake driver —
 * never fake passes. The operations console (pageShell pages) is outside
 * the repo's verified 44px floor set, so its touch check is a named skip
 * (the honest scoping of RL-114), not a failure.
 */
import type { BrowserContext, HeadingNode } from "./driver.js";

export interface A11yCheckOutcome {
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

/** The shell family of the walked page (drives which checks apply). */
export type PageKind = "app-shell" | "session-shell" | "ops-console";

export interface A11yBatteryInput {
  readonly pageKind: PageKind;
  readonly mobileViewport: boolean;
}

/**
 * The verified 44px floor families (apps/web/src/styles.ts +
 * packages/app-kit/src/ui/shell.ts + the login document's own floors).
 * Deliberately NOT every interactive element: radios/checkboxes ride their
 * floored labels (.preference-option / .onboarding-goal), and the
 * onboarding primary action anchor is outside the repo's verified set.
 */
const APP_SHELL_FLOOR_SELECTORS: readonly string[] = [
  "button",
  'form input[type="text"]',
  "form select",
  "details summary",
  ".more-item-link",
  ".support-escape a",
  ".order-link",
  ".home-fact-action a",
  ".journey-action a",
  ".goal-card a",
  ".preference-option",
  ".shell-indicator-link",
  ".shell-sidebar-nav a",
  ".shell-bottom-nav a",
];

const SESSION_SHELL_FLOOR_SELECTORS: readonly string[] = [
  'form button[type="submit"]',
  ".demo-account-button",
];

/** The subpixel tolerance for rendered floor measurement. */
const FLOOR_TOLERANCE_PX = 0.5;

/** The touch-target floor (spec/ux-architecture.md §14). */
export const TOUCH_TARGET_FLOOR_PX = 44;

/** The number of keyboard tab stops sampled per page. */
const TAB_STOP_SAMPLE = 6;

export async function runA11yBattery(
  ctx: BrowserContext,
  input: A11yBatteryInput,
): Promise<readonly A11yCheckOutcome[]> {
  const outcomes: A11yCheckOutcome[] = [];
  const { pageKind, mobileViewport } = input;
  const capabilities = ctx.capabilities;

  // --- exactly one h1 -------------------------------------------------------
  const h1Count = await ctx.count("h1");
  outcomes.push({
    name: "one-h1",
    status: h1Count === 1 ? "pass" : "fail",
    detail:
      h1Count === 1
        ? "the document carries exactly one h1 (the shell title contract)"
        : `the document carries ${h1Count} h1 elements (expected exactly 1)`,
  });

  // --- no heading-level skips -----------------------------------------------
  const headings = await ctx.headings();
  outcomes.push(headingOrderOutcome(headings));

  // --- the skip link (application shell pages) -------------------------------
  if (pageKind === "app-shell") {
    const skipCount = await ctx.count('a.shell-skip-link');
    const skipHref = skipCount > 0 ? await ctx.attr('a.shell-skip-link', "href") : null;
    const ok = skipCount === 1 && skipHref === "#shell-main";
    outcomes.push({
      name: "skip-link",
      status: ok ? "pass" : "fail",
      detail: ok
        ? "the skip link to #shell-main is rendered once"
        : `the skip link contract failed (count ${skipCount}, href ${JSON.stringify(skipHref)})`,
    });
  } else {
    outcomes.push({
      name: "skip-link",
      status: "skip",
      detail:
        pageKind === "session-shell"
          ? "the login document uses the session shell (no skip link by design)"
          : "the operations console uses the page shell (no skip link by design)",
    });
  }

  // --- the mobile bottom nav / desktop sidebar -------------------------------
  if (pageKind === "app-shell") {
    const bottomNavCount = await ctx.count("nav.shell-bottom-nav");
    if (bottomNavCount === 0) {
      outcomes.push({
        name: mobileViewport ? "bottom-nav-mobile" : "sidebar-desktop",
        status: "fail",
        detail: "the bottom navigation is not rendered in the document",
      });
    } else if (mobileViewport) {
      if (capabilities.layout) {
        const displayed = await ctx.isDisplayed("nav.shell-bottom-nav");
        outcomes.push({
          name: "bottom-nav-mobile",
          status: displayed ? "pass" : "fail",
          detail: displayed
            ? "the mobile bottom navigation is present and displayed at mobile width"
            : "the bottom navigation exists but is not displayed at mobile width",
        });
      } else {
        outcomes.push({
          name: "bottom-nav-mobile",
          status: "skip",
          detail: `present in the document (count ${bottomNavCount}); display verification skipped (no layout on the ${capabilities.label})`,
        });
      }
    } else {
      if (capabilities.layout) {
        const displayed = await ctx.isDisplayed("nav.shell-sidebar-nav");
        outcomes.push({
          name: "sidebar-desktop",
          status: displayed ? "pass" : "fail",
          detail: displayed
            ? "the desktop sidebar navigation is displayed at desktop width"
            : "the sidebar navigation is not displayed at desktop width",
        });
      } else {
        outcomes.push({
          name: "sidebar-desktop",
          status: "skip",
          detail: `present in the document; display verification skipped (no layout on the ${capabilities.label})`,
        });
      }
    }
  } else {
    outcomes.push({
      name: mobileViewport ? "bottom-nav-mobile" : "sidebar-desktop",
      status: "skip",
      detail: "not an application-shell page (no shell navigation by design)",
    });
  }

  // --- the 44px touch-target floor -------------------------------------------
  const floorSelectors =
    pageKind === "app-shell"
      ? APP_SHELL_FLOOR_SELECTORS
      : pageKind === "session-shell"
        ? SESSION_SHELL_FLOOR_SELECTORS
        : [];
  if (floorSelectors.length === 0) {
    outcomes.push({
      name: "touch-targets",
      status: "skip",
      detail:
        "the operations console (page shell) is outside the repo's verified 44px floor set (RL-114 scoped the floor to the customer web-app styles) — an honest scoping note, not a measured pass",
    });
  } else if (!capabilities.layout) {
    outcomes.push({
      name: "touch-targets",
      status: "skip",
      detail: `layout measurement unavailable on the ${capabilities.label} (named skip; the structural checks still ran)`,
    });
  } else {
    const measures = await ctx.measureTargets(floorSelectors);
    const below = measures.filter(
      (measure) => measure.height < TOUCH_TARGET_FLOOR_PX - FLOOR_TOLERANCE_PX,
    );
    outcomes.push({
      name: "touch-targets",
      status: below.length === 0 ? "pass" : "fail",
      detail:
        below.length === 0
          ? `${measures.length} visible target(s) across the verified floor families all measure >= ${TOUCH_TARGET_FLOOR_PX}px`
          : `target(s) below the ${TOUCH_TARGET_FLOOR_PX}px floor: ${below
              .map((measure) => `${measure.description} (${measure.height.toFixed(1)}px, ${measure.selector})`)
              .join("; ")
              .slice(0, 400)}`,
    });
  }

  // --- keyboard reachability + focus visibility ------------------------------
  if (!capabilities.keyboard) {
    outcomes.push({
      name: "tab-order-sample",
      status: "skip",
      detail: `keyboard events unavailable on the ${capabilities.label} (named skip)`,
    });
    outcomes.push({
      name: "focus-visibility",
      status: "skip",
      detail: `keyboard events unavailable on the ${capabilities.label} (named skip)`,
    });
  } else {
    const stops = await ctx.tabStops(TAB_STOP_SAMPLE);
    const invisible = stops.filter((stop) => !stop.visible);
    outcomes.push({
      name: "tab-order-sample",
      status: stops.length >= 1 && invisible.length === 0 ? "pass" : "fail",
      detail:
        stops.length === 0
          ? "no keyboard-reachable content was focusable (expected the page's links/controls to accept keyboard focus)"
          : `${stops.length} stop(s) sampled${invisible.length === 0 ? "" : `; INVISIBLE stops: ${invisible.map((stop) => stop.description).join("; ").slice(0, 300)}`}`,
    });
    const unfocused = stops.filter((stop) => !stop.focusIndicator);
    outcomes.push({
      name: "focus-visibility",
      status: stops.length > 0 && unfocused.length === 0 ? "pass" : "fail",
      detail:
        stops.length === 0
          ? "no stops to evidence focus visibility"
          : unfocused.length === 0
            ? `every sampled stop shows a focus indicator (${stops.length}/${stops.length})`
            : `stop(s) without a visible focus indicator: ${unfocused
                .map((stop) => `${stop.description} [${stop.focusDetail}]`)
                .join("; ")
                .slice(0, 400)}`,
    });
  }

  return outcomes;
}

/** The heading-order check (shared with the report's per-page record). */
export function headingOrderOutcome(headings: readonly HeadingNode[]): A11yCheckOutcome {
  if (headings.length === 0) {
    return {
      name: "heading-order",
      status: "fail",
      detail: "the document renders no headings at all",
    };
  }
  const problems: string[] = [];
  const first = headings[0];
  if (first === undefined || first.tag !== "h1") {
    problems.push(`the first heading is ${first?.tag ?? "none"} (expected h1)`);
  }
  let currentRank = 1;
  for (const heading of headings) {
    const rank = Number.parseInt(heading.tag.slice(1), 10);
    if (rank > currentRank + 1) {
      problems.push(`${heading.tag} "${heading.text.slice(0, 40)}" skips from h${currentRank}`);
    }
    if (rank > currentRank) currentRank = rank;
  }
  return {
    name: "heading-order",
    status: problems.length === 0 ? "pass" : "fail",
    detail:
      problems.length === 0
        ? `${headings.length} headings form a valid hierarchy (h1 first, no skipped levels)`
        : problems.join("; ").slice(0, 400),
  };
}
