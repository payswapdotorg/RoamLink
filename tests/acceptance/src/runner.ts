/**
 * The acceptance runner (PA-021): executes the journey matrix at both
 * viewport classes and produces the level report.
 *
 * ORCHESTRATION per viewport (desktop 1280x800, mobile 390x844 — the
 * bottom-nav breakpoint of the shell stylesheet):
 *   1. a CUSTOMER context: the login journey (which performs the real
 *      login through the rendered surface) followed by the customer
 *      journeys in the handoff's final-individual-journey order;
 *   2. an OWNER context: login + the admin/operations journeys.
 *
 * RESILIENCE, honestly recorded: every navigation gets ONE bounded retry on
 * a transport failure, and a mid-suite session drop (the unexpected
 * /login redirect) gets ONE relogin — both counted in the report, never
 * silently swallowed.
 *
 * THE EXIT CONTRACT ("no lies"): a leg FAILED only when it could not
 * evidence its floor — the route never answered, the document broke the
 * shell contract, or a submitted form produced NO typed outcome panel.
 * Honest runtime limitations (stops) never fail. A11y check failures are
 * product-contract violations and DO fail the run (each named).
 */
import { LEVELS, furthestLevel, levelRank, type Level } from "./levels.js";
import type { AcceptanceRunConfig, PersonaCredentials } from "./config.js";
import type { BrowserContext, BrowserDriver, PageSnapshot, Viewport } from "./driver.js";
import { runA11yBattery, type A11yCheckOutcome, type PageKind } from "./a11y.js";
import {
  CUSTOMER_JOURNEYS,
  OPERATOR_JOURNEYS,
  type DegradedPanel,
  type JourneyHarness,
  type LegRecord,
  type LegRecorder,
  type LoginOutcome,
} from "./journeys.js";

/** The two mandated viewport classes (§3.1). */
export const VIEWPORTS: readonly { readonly label: "desktop" | "mobile"; readonly size: Viewport }[] = Object.freeze([
  { label: "desktop", size: { width: 1280, height: 800 } },
  { label: "mobile", size: { width: 390, height: 844 } },
]);

export interface JourneySummary {
  readonly journey: string;
  readonly persona: string;
  readonly viewport: "desktop" | "mobile";
  /** The furthest level any of the journey's legs evidenced. */
  readonly furthestLevel: Level | null;
  readonly legs: readonly {
    readonly leg: string;
    readonly reachedLevel: Level | null;
    readonly targetLevel: Level;
    readonly stopReason?: string;
    readonly failure?: string;
    readonly degradedPanels: number;
  }[];
  readonly honestStops: readonly string[];
}

export interface AcceptanceRunReport {
  readonly startedAt: string;
  readonly baseUrl: string;
  readonly driverLabel: string;
  readonly viewports: readonly { readonly label: string; readonly width: number; readonly height: number }[];
  readonly personas: readonly string[];
  readonly status: "completed";
  readonly legs: readonly LegRecord[];
  readonly journeys: readonly JourneySummary[];
  readonly levelCounts: Readonly<Record<Level, number>>;
  readonly honestStopCounts: readonly { readonly reason: string; readonly count: number }[];
  readonly a11yCounts: Readonly<Record<string, { readonly pass: number; readonly fail: number; readonly skip: number }>>;
  readonly a11yFailures: readonly string[];
  readonly retries: { readonly navigationRetries: number; readonly relogins: number };
  readonly legFailures: readonly string[];
  readonly verdict: "no-lies" | "lies-detected";
}

export interface RunnerInput {
  readonly config: AcceptanceRunConfig & { readonly status: "configured"; readonly baseUrl: string };
  readonly driver: BrowserDriver;
  readonly log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// The leg recorder
// ---------------------------------------------------------------------------

class RecordingLeg implements LegRecorder {
  readonly journey: string;
  readonly leg: string;
  readonly targetLevel: Level;
  readonly persona: string;
  readonly viewport: "desktop" | "mobile";

  #reached: Level | null = null;
  #stopReason: string | undefined;
  #failure: string | undefined;
  readonly #evidence: string[] = [];
  readonly #panels: DegradedPanel[] = [];
  #a11y: readonly A11yCheckOutcome[] = [];
  #a11yRan = false;
  #retries = 0;

  readonly #ctx: BrowserContext;
  readonly #mobileViewport: boolean;

  constructor(input: {
    readonly journey: string;
    readonly leg: string;
    readonly targetLevel: Level;
    readonly persona: string;
    readonly viewport: "desktop" | "mobile";
    readonly ctx: BrowserContext;
  }) {
    this.journey = input.journey;
    this.leg = input.leg;
    this.targetLevel = input.targetLevel;
    this.persona = input.persona;
    this.viewport = input.viewport;
    this.#ctx = input.ctx;
    this.#mobileViewport = input.viewport === "mobile";
  }

  record(level: Level, evidence: string): void {
    this.#evidence.push(evidence);
    this.#reached = this.#reached === null ? level : furthestLevel(this.#reached, level);
  }

  note(text: string): void {
    this.#evidence.push(text);
  }

  stop(reason: string): void {
    if (this.#stopReason === undefined) this.#stopReason = reason;
  }

  fail(message: string): void {
    if (this.#failure === undefined) this.#failure = message;
  }

  countRetry(): void {
    this.#retries += 1;
  }

  async collectDegradedPanels(): Promise<void> {
    const sections = await this.#ctx.attrAll("[data-unavailable]", "data-unavailable-section");
    const reasons = await this.#ctx.attrAll("[data-unavailable]", "data-unavailable-reason");
    for (let index = 0; index < sections.length; index += 1) {
      this.#panels.push({
        section: sections[index] ?? "unknown",
        reason: reasons[index] ?? "unknown",
      });
    }
  }

  async a11y(pageKind: PageKind): Promise<void> {
    if (this.#a11yRan) return;
    this.#a11yRan = true;
    this.#a11y = await runA11yBattery(this.#ctx, { pageKind, mobileViewport: this.#mobileViewport });
  }

  finalize(): LegRecord {
    return {
      journey: this.journey,
      leg: this.leg,
      persona: this.persona,
      viewport: this.viewport,
      targetLevel: this.targetLevel,
      reachedLevel: this.#reached,
      ...(this.#stopReason !== undefined ? { stopReason: this.#stopReason } : {}),
      ...(this.#failure !== undefined ? { failure: this.#failure } : {}),
      evidence: Object.freeze([...this.#evidence]),
      degradedPanels: Object.freeze([...this.#panels]),
      a11y: Object.freeze([...this.#a11y]),
      retries: this.#retries,
    };
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

class Harness implements JourneyHarness {
  readonly ctx: BrowserContext;
  readonly persona: PersonaCredentials;
  readonly viewport: "desktop" | "mobile";
  readonly stamp: string;
  readonly scratch = new Map<string, string>();

  readonly #openLegs: RecordingLeg[] = [];
  readonly #reloginCounter: { relogins: number; navigationRetries: number };

  constructor(input: {
    readonly ctx: BrowserContext;
    readonly persona: PersonaCredentials;
    readonly viewport: "desktop" | "mobile";
    readonly stamp: string;
    readonly counters: { relogins: number; navigationRetries: number };
  }) {
    this.ctx = input.ctx;
    this.persona = input.persona;
    this.viewport = input.viewport;
    this.stamp = input.stamp;
    this.#reloginCounter = input.counters;
  }

  leg(journey: string, legName: string, targetLevel: Level): LegRecorder {
    const recorder = new RecordingLeg({
      journey,
      leg: legName,
      targetLevel,
      persona: this.persona.label,
      viewport: this.viewport,
      ctx: this.ctx,
    });
    this.#openLegs.push(recorder);
    return recorder;
  }

  /** Finalizes every leg opened during one journey (in order). */
  takeLegs(): readonly LegRecord[] {
    const records = this.#openLegs.map((leg) => leg.finalize());
    this.#openLegs.length = 0;
    return records;
  }

  async navigate(path: string): Promise<PageSnapshot> {
    let snapshot = await this.#gotoWithRetry(path);
    if (!snapshot.failed && pathOf(snapshot.url) === "/login" && path !== "/login") {
      // The session dropped mid-suite: ONE relogin + one retry (recorded).
      this.#reloginCounter.relogins += 1;
      await this.login();
      const retryLeg = this.#openLegs[this.#openLegs.length - 1];
      retryLeg?.countRetry();
      snapshot = await this.#gotoWithRetry(path);
    }
    return snapshot;
  }

  async login(): Promise<LoginOutcome> {
    const { ctx } = this;
    await ctx.goto("/login");
    // The authenticated-surface predicate: the landing page must render an
    // application-shell marker (never just "not /login" — a bare 200 page
    // is not an authenticated surface).
    const authenticatedSurface = async (): Promise<boolean> =>
      (await ctx.count("a.shell-skip-link")) > 0 ||
      (await ctx.count("nav.shell-sidebar-nav")) > 0 ||
      (await ctx.count("a.shell-title")) > 0;
    // Mobile walks the demo quick-action (the roster contract); desktop
    // walks the manual credential form — submitted via keyboard Enter when
    // the driver has a keyboard (the forms-submittable-via-keyboard proof).
    const quickForm = `form[data-demo-account="${this.persona.label}"]`;
    if (this.viewport === "mobile" && (await ctx.count(quickForm)) > 0) {
      const landed = await ctx.submit(quickForm);
      const ok = !landed.failed && pathOf(landed.url) !== "/login" && (await authenticatedSurface());
      return {
        ok,
        via: "quick-action",
        detail: ok
          ? `the demo quick-action form for the ${this.persona.label} persona submitted and landed on ${pathOf(landed.url) || "/"}`
          : "the quick-action submission did not land an authenticated application-shell surface",
      };
    }
    const manualForm = 'form[action="/auth/session"]';
    if ((await ctx.count(manualForm)) === 0) {
      return { ok: false, via: "credentials+click", detail: "the manual credential form is not rendered on the login document" };
    }
    await ctx.fillText(manualForm, "email", this.persona.email);
    await ctx.fillText(manualForm, "password", this.persona.password);
    if (this.ctx.capabilities.keyboard) {
      const enterResult = await ctx.pressEnterIn(manualForm);
      if (enterResult.navigated && pathOf(enterResult.url) !== "/login" && (await authenticatedSurface())) {
        return {
          ok: true,
          via: "credentials+enter",
          detail: `the credential form submitted via keyboard Enter and landed on ${pathOf(enterResult.url) || "/"}`,
        };
      }
    }
    const landed = await ctx.submit(manualForm);
    const ok = !landed.failed && pathOf(landed.url) !== "/login" && (await authenticatedSurface());
    return {
      ok,
      via: "credentials+click",
      detail: ok
        ? `the credential form submitted and landed on ${pathOf(landed.url) || "/"}`
        : "the credential submission did not land an authenticated application-shell surface",
    };
  }

  async #gotoWithRetry(path: string): Promise<PageSnapshot> {
    let snapshot = await this.ctx.goto(path);
    if (snapshot.failed) {
      this.#reloginCounter.navigationRetries += 1;
      const leg = this.#openLegs[this.#openLegs.length - 1];
      leg?.countRetry();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      snapshot = await this.ctx.goto(path);
    }
    return snapshot;
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export async function runAcceptanceMatrix(input: RunnerInput): Promise<AcceptanceRunReport> {
  const { config, driver } = input;
  const log = input.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const counters = { relogins: 0, navigationRetries: 0 };
  const allLegs: LegRecord[] = [];

  for (const viewport of VIEWPORTS) {
    // --- the customer persona's context -------------------------------------
    {
      const ctx = await driver.openContext(viewport.size, config.timeoutMs);
      try {
        const harness = new Harness({
          ctx,
          persona: config.customer,
          viewport: viewport.label,
          stamp,
          counters,
        });
        for (const journey of CUSTOMER_JOURNEYS) {
          try {
            await journey(harness);
          } catch (error) {
            const leg = harness.leg("runner", "internal-error", "route-reachable");
            leg.fail(`the journey itself threw (${error instanceof Error ? error.message : "unknown error"})`);
          }
          allLegs.push(...harness.takeLegs());
        }
      } finally {
        await ctx.close();
      }
    }

    // --- the owner persona's context ----------------------------------------
    {
      const ctx = await driver.openContext(viewport.size, config.timeoutMs);
      try {
        const harness = new Harness({
          ctx,
          persona: config.adminPersona,
          viewport: viewport.label,
          stamp,
          counters,
        });
        for (const journey of OPERATOR_JOURNEYS) {
          try {
            await journey(harness);
          } catch (error) {
            const leg = harness.leg("runner", "internal-error", "route-reachable");
            leg.fail(`the journey itself threw (${error instanceof Error ? error.message : "unknown error"})`);
          }
          allLegs.push(...harness.takeLegs());
        }
      } finally {
        await ctx.close();
      }
    }
    log(`[acceptance] ${viewport.label} viewport complete (${allLegs.length} legs so far)`);
  }

  return buildReport({ config, driverLabel: driver.capabilities.label, startedAt, legs: allLegs, counters });
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export function buildReport(input: {
  readonly config: AcceptanceRunConfig;
  readonly driverLabel: string;
  readonly startedAt: string;
  readonly legs: readonly LegRecord[];
  readonly counters: { readonly relogins: number; readonly navigationRetries: number };
}): AcceptanceRunReport {
  const { legs } = input;

  const journeys: JourneySummary[] = [];
  const seen = new Set<string>();
  for (const leg of legs) {
    const key = `${leg.journey}/${leg.persona}/${leg.viewport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const journeyLegs = legs.filter(
      (candidate) => candidate.journey === leg.journey && candidate.persona === leg.persona && candidate.viewport === leg.viewport,
    );
    let furthest: Level | null = null;
    const honestStops: string[] = [];
    for (const candidate of journeyLegs) {
      if (candidate.reachedLevel === null) continue;
      furthest = furthest === null ? candidate.reachedLevel : furthestLevel(furthest, candidate.reachedLevel);
      if (candidate.stopReason !== undefined) honestStops.push(candidate.stopReason);
    }
    journeys.push({
      journey: leg.journey,
      persona: leg.persona,
      viewport: leg.viewport,
      furthestLevel: furthest,
      legs: journeyLegs.map((candidate) => ({
        leg: candidate.leg,
        reachedLevel: candidate.reachedLevel,
        targetLevel: candidate.targetLevel,
        ...(candidate.stopReason !== undefined ? { stopReason: candidate.stopReason } : {}),
        ...(candidate.failure !== undefined ? { failure: candidate.failure } : {}),
        degradedPanels: candidate.degradedPanels.length,
      })),
      honestStops,
    });
  }
  journeys.sort((a, b) => levelRankOf(b.furthestLevel) - levelRankOf(a.furthestLevel));

  const levelCounts = {} as Record<Level, number>;
  for (const level of LEVELS) levelCounts[level] = 0;
  for (const leg of legs) {
    if (leg.reachedLevel !== null) levelCounts[leg.reachedLevel] += 1;
  }

  const stopReasons = new Map<string, number>();
  for (const leg of legs) {
    if (leg.stopReason === undefined) continue;
    const key = leg.stopReason.split("(")[0]?.trim() ?? leg.stopReason;
    stopReasons.set(key, (stopReasons.get(key) ?? 0) + 1);
  }
  const honestStopCounts = [...stopReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const a11yCounts: Record<string, { pass: number; fail: number; skip: number }> = {};
  const a11yFailures: string[] = [];
  for (const leg of legs) {
    for (const check of leg.a11y) {
      const bucket = a11yCounts[check.name] ?? { pass: 0, fail: 0, skip: 0 };
      bucket[check.status] += 1;
      a11yCounts[check.name] = bucket;
      if (check.status === "fail") {
        a11yFailures.push(`[${leg.persona}/${leg.viewport}/${leg.journey}/${leg.leg}] ${check.name}: ${check.detail}`);
      }
    }
  }

  const legFailures = legs
    .filter((leg) => leg.failure !== undefined)
    .map((leg) => `[${leg.persona}/${leg.viewport}/${leg.journey}/${leg.leg}] ${leg.failure ?? "unknown failure"}`);

  const verdict: AcceptanceRunReport["verdict"] =
    legFailures.length === 0 && a11yFailures.length === 0 ? "no-lies" : "lies-detected";

  return {
    startedAt: input.startedAt,
    baseUrl: input.config.status === "configured" ? input.config.baseUrl : "(unset)",
    driverLabel: input.driverLabel,
    viewports: VIEWPORTS.map((viewport) => ({
      label: viewport.label,
      width: viewport.size.width,
      height: viewport.size.height,
    })),
    personas: [input.config.customer.label, input.config.adminPersona.label],
    status: "completed",
    legs,
    journeys,
    levelCounts,
    honestStopCounts,
    a11yCounts,
    a11yFailures,
    retries: { ...input.counters },
    legFailures,
    verdict,
  };
}

function levelRankOf(level: Level | null): number {
  return level === null ? -1 : levelRank(level);
}
