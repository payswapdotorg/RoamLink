/**
 * The browser-driver abstraction (PA-021).
 *
 * The journey matrix programs against THIS interface only, so the same
 * journey/leg/level machinery runs against:
 *
 *  - the REAL headless-browser driver (Playwright + Chromium) — used for the
 *    deployed run and, when a browser is available, the selftest's deeper
 *    leg; and
 *  - the OFFLINE fake driver (fetch + document-level scanners over the
 *    loopback-only fixture site) — the deterministic zero-browser core that
 *    keeps `pnpm check` green on any box. The fake driver speaks the same
 *    marker vocabulary (data attributes + structural HTML) the repo's own
 *    e2e suite scans, so the machinery — level recording, the honest-stop
 *    taxonomy, mutation submissions through the real flow plane, report
 *    emission — is exercised identically.
 *
 * Capability honesty (the suite's own law applied to itself): the fake
 * driver advertises `layout: false, keyboard: false`; the a11y battery
 * runs its structural checks everywhere and records NAMED SKIPS for the
 * layout/keyboard-dependent checks when the driver cannot evidence them —
 * never a fake pass.
 */
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface PageSnapshot {
  /** The final URL after redirects (absolute). */
  readonly url: string;
  /** The final HTTP status (the last response in the redirect chain). */
  readonly status: number;
  /** The response body (HTML document) — empty only for bodiless answers. */
  readonly body: string;
  /** True when the driver could not load the page at all (timeout/crash). */
  readonly failed: boolean;
  readonly failureDetail?: string;
  /** True when the last action produced a real navigation/render change. */
  readonly navigated: boolean;
}

export interface HeadingNode {
  readonly tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  readonly text: string;
}

export interface TabStop {
  readonly description: string;
  readonly visible: boolean;
  readonly focusIndicator: boolean;
  readonly focusDetail: string;
  /** True when this stop is the document body (the wrap point — excluded). */
  readonly isBody: boolean;
}

export interface TargetMeasure {
  readonly selector: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
}

export interface DriverCapabilities {
  /** The driver label for the report (e.g. "playwright 1.63.0/chromium"). */
  readonly label: string;
  /** True when real layout (bounding boxes) can be measured. */
  readonly layout: boolean;
  /** True when real keyboard events (tab order, Enter submission) work. */
  readonly keyboard: boolean;
  /** True when this is a real browser engine. */
  readonly realBrowser: boolean;
}

/** The error a driver throws for an operation outside its capabilities. */
export class DriverCapabilityUnavailable extends Error {
  constructor(operation: string, driver: string) {
    super(
      `the "${operation}" operation is unavailable on the "${driver}" driver (capability-gated; record a named skip, never a fake pass)`,
    );
    this.name = "DriverCapabilityUnavailable";
  }
}

export interface BrowserContext {
  readonly viewport: Viewport;
  readonly capabilities: DriverCapabilities;

  /** Navigates to a path on the target origin (follows redirects). */
  goto(path: string): Promise<PageSnapshot>;
  /** The current page snapshot. */
  snapshot(): Promise<PageSnapshot>;
  /** Number of elements matching a simple CSS selector. */
  count(selector: string): Promise<number>;
  /** The named attribute of the FIRST element matching the selector. */
  attr(selector: string, attribute: string): Promise<string | null>;
  /** The named attribute of EVERY element matching the selector. */
  attrAll(selector: string, attribute: string): Promise<readonly string[]>;
  /** True when the document content matches the pattern. */
  contentMatches(pattern: RegExp): Promise<boolean>;
  /** The document's headings in document order. */
  headings(): Promise<readonly HeadingNode[]>;

  // --- form driving (the real flow plane) ---------------------------------
  /** Types text into the named field of the matched form. */
  fillText(formSelector: string, name: string, value: string): Promise<void>;
  /** Chooses the named select's option value. */
  selectOption(formSelector: string, name: string, value: string): Promise<void>;
  /** Checks the named checkbox/radio with the given value. */
  check(formSelector: string, name: string, value: string): Promise<void>;
  /**
   * Submits the matched form by clicking its submit button (a real browser
   * submission — cookies, the Origin header and the form-encoded body all
   * ride the browser's own machinery). Returns the resulting page snapshot;
   * throws when the form is not rendered or the submission never left the
   * page (an honest defect, never a silent no-op).
   */
  submit(formSelector: string): Promise<PageSnapshot>;
  /** Clicks the first link matching the selector and follows it. */
  clickLink(selector: string): Promise<PageSnapshot>;
  /**
   * Keyboard-submits the matched form: focuses its first text-ish control and
   * presses Enter. Returns the resulting snapshot; `navigated` is false when
   * no navigation happened.
   */
  pressEnterIn(formSelector: string): Promise<PageSnapshot>;

  // --- layout/keyboard probes (capability-gated) ---------------------------
  /** Samples the first `stops` tab stops from the top of the document. */
  tabStops(stops: number): Promise<readonly TabStop[]>;
  /**
   * Measures the visible interactive targets matching the selectors
   * (bounding boxes in CSS pixels).
   */
  measureTargets(selectors: readonly string[]): Promise<readonly TargetMeasure[]>;
  /** True when the selector's first match is displayed (layout only). */
  isDisplayed(selector: string): Promise<boolean>;

  close(): Promise<void>;
}

export interface BrowserDriver {
  readonly capabilities: DriverCapabilities;
  /** Opens an isolated context (its own cookie jar) at the viewport. */
  openContext(viewport: Viewport, timeoutMs: number): Promise<BrowserContext>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The offline fake driver (fetch + document-level scanners)
// ---------------------------------------------------------------------------

interface ParsedSelector {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attrs: readonly {
    readonly name: string;
    readonly value?: string;
    readonly operator?: "=" | "^=";
  }[];
}

/**
 * Parses the small selector grammar the journeys use (tag, .class, #id and
 * [attr]/[attr="value"] constraints, combinable: `form[data-flow="x"]`).
 * Descendant combinators are deliberately NOT supported — the portal's
 * stable contract is its data-attribute markers, which are unique per form.
 */
export function parseSelector(selector: string): ParsedSelector {
  const input = selector.trim();
  if (input.length === 0 || /[>+~\s]/.test(input)) {
    throw new Error(
      `unsupported selector ${JSON.stringify(selector)} (the fake driver speaks tag/.class/#id/[attr] only, no combinators)`,
    );
  }
  let rest: string = input;
  let tag: string | undefined;
  let id: string | undefined;
  const classes: string[] = [];
  const attrs: { name: string; value?: string; operator?: "=" | "^=" }[] = [];

  const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tagMatch !== null && tagMatch[0] !== undefined) {
    tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tag.length);
  }
  const tokenPattern = /(\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[[^\]]+\])/;
  for (;;) {
    const match = tokenPattern.exec(rest);
    if (match === null || match[1] === undefined) break;
    const token = match[1];
    rest = rest.slice(0, match.index) + rest.slice(match.index + token.length);
    if (token.startsWith(".")) classes.push(token.slice(1));
    else if (token.startsWith("#")) id = token.slice(1);
    else {
      const inner = token.slice(1, -1);
      const attrMatch = /^([a-zA-Z0-9_-]+)(\^)?(?:\s*=\s*"([^"]*)")?$/.exec(inner);
      if (attrMatch === null || attrMatch[1] === undefined) {
        throw new Error(`unsupported attribute constraint ${token} in ${JSON.stringify(selector)}`);
      }
      const operator: "=" | "^=" = attrMatch[2] === "^" ? "^=" : "=";
      const value = attrMatch[3];
      attrs.push(
        value === undefined
          ? { name: attrMatch[1], operator: "=" }
          : { name: attrMatch[1], value, operator },
      );
    }
  }
  if (rest.length > 0) {
    throw new Error(`unsupported selector ${JSON.stringify(selector)} (residual ${JSON.stringify(rest)})`);
  }
  return {
    ...(tag !== undefined ? { tag } : {}),
    ...(id !== undefined ? { id } : {}),
    classes,
    attrs,
  };
}

function attributesOf(openTag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of openTag.matchAll(/([a-zA-Z0-9_:.-]+)\s*=\s*"([^"]*)"/g)) {
    if (match[1] === undefined || match[2] === undefined) continue;
    attrs.set(match[1].toLowerCase(), match[2]);
  }
  return attrs;
}

function selectorMatches(openTag: string, selector: ParsedSelector): boolean {
  const tagMatch = /^<([a-zA-Z0-9-]+)/.exec(openTag);
  if (tagMatch === null || tagMatch[1] === undefined) return false;
  if (selector.tag !== undefined && tagMatch[1].toLowerCase() !== selector.tag) return false;
  const attrs = attributesOf(openTag);
  if (selector.id !== undefined && attrs.get("id") !== selector.id) return false;
  const classAttr = attrs.get("class") ?? "";
  const classList = classAttr.split(/\s+/).filter((entry) => entry.length > 0);
  for (const wanted of selector.classes) {
    if (!classList.includes(wanted)) return false;
  }
  for (const constraint of selector.attrs) {
    if (constraint.value === undefined) {
      if (!attrs.has(constraint.name)) return false;
    } else if (constraint.operator === "^=") {
      const actual = attrs.get(constraint.name);
      if (actual === undefined || !actual.startsWith(constraint.value)) return false;
    } else if (attrs.get(constraint.name) !== constraint.value) {
      return false;
    }
  }
  return true;
}

/** All opening tags in document order (`<h1 ...>`, `<form ...>`, ...). */
function openingTags(body: string): string[] {
  return [...body.matchAll(/<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/g)].map((match) => match[0]);
}

interface FormBlock {
  readonly openTag: string;
  readonly html: string;
  readonly action: string;
  readonly method: string;
}

function formBlocks(body: string): FormBlock[] {
  const blocks: FormBlock[] = [];
  for (const match of body.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    const openTag = (match[0].match(/<form\b[^>]*>/) ?? ["<form>"])[0];
    const attrs = attributesOf(openTag);
    blocks.push({
      openTag,
      html: match[1] ?? "",
      action: attrs.get("action") ?? "",
      method: (attrs.get("method") ?? "get").toLowerCase(),
    });
  }
  return blocks;
}

/**
 * The offline fake driver's context: a cookie-jarred fetch client plus
 * document-level scanners. Form submissions build the form-encoded body
 * from the rendered hidden fields + the driver-typed values and POST it to
 * the form's action with the same-origin Origin header (the host's CSRF
 * seam accepts exactly that), so mutations ride the real flow plane.
 */
class FakeBrowserContext implements BrowserContext {
  readonly capabilities: DriverCapabilities = {
    label: "offline-fake-driver (fetch + document scanners)",
    layout: false,
    keyboard: false,
    realBrowser: false,
  };

  readonly #origin: string;
  readonly #viewport: Viewport;
  readonly #cookies = new Map<string, string>();
  readonly #formState = new Map<string, Map<string, string[]>>();
  #current: PageSnapshot;

  constructor(origin: string, viewport: Viewport) {
    this.#origin = origin;
    this.#viewport = viewport;
    this.#current = {
      url: `${origin}/`,
      status: 0,
      body: "",
      failed: true,
      failureDetail: "no navigation yet",
      navigated: false,
    };
  }

  get viewport(): Viewport {
    return this.#viewport;
  }

  async goto(path: string): Promise<PageSnapshot> {
    this.#formState.clear();
    this.#current = await this.#load(new URL(path, this.#origin).toString());
    return this.#current;
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.#current;
  }

  async count(selector: string): Promise<number> {
    const parsed = parseSelector(selector);
    return openingTags(this.#current.body).filter((tag) => selectorMatches(tag, parsed)).length;
  }

  async attr(selector: string, attribute: string): Promise<string | null> {
    const parsed = parseSelector(selector);
    const wanted = attribute.toLowerCase();
    const tag = openingTags(this.#current.body).find((candidate) => selectorMatches(candidate, parsed));
    return tag === undefined ? null : (attributesOf(tag).get(wanted) ?? null);
  }

  async attrAll(selector: string, attribute: string): Promise<readonly string[]> {
    const parsed = parseSelector(selector);
    const wanted = attribute.toLowerCase();
    return openingTags(this.#current.body)
      .filter((tag) => selectorMatches(tag, parsed))
      .map((tag) => attributesOf(tag).get(wanted) ?? "")
      .filter((value) => value.length > 0);
  }

  async contentMatches(pattern: RegExp): Promise<boolean> {
    return pattern.test(this.#current.body);
  }

  async headings(): Promise<readonly HeadingNode[]> {
    const nodes: HeadingNode[] = [];
    for (const match of this.#current.body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
      const tag = `h${match[1]}` as HeadingNode["tag"];
      const text = (match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      nodes.push({ tag, text });
    }
    return nodes;
  }

  async fillText(formSelector: string, name: string, value: string): Promise<void> {
    this.#formFieldState(formSelector).set(name, [value]);
  }

  async selectOption(formSelector: string, name: string, value: string): Promise<void> {
    this.#formFieldState(formSelector).set(name, [value]);
  }

  async check(formSelector: string, name: string, value: string): Promise<void> {
    const state = this.#formFieldState(formSelector);
    const existing = state.get(name) ?? [];
    if (!existing.includes(value)) state.set(name, [...existing, value]);
  }

  async submit(formSelector: string): Promise<PageSnapshot> {
    const block = this.#locateForm(formSelector);
    if (block === undefined) {
      throw new Error(
        `the form ${formSelector} is not rendered on the current page (never submit an unrendered form)`,
      );
    }
    const body = this.#encodeForm(block, formSelector);
    const action = this.#resolveHref(block.action);
    this.#formState.clear();
    if (block.method === "get") {
      this.#current = await this.#load(`${action}?${body}`);
    } else {
      this.#current = await this.#load(action, { method: "POST", body });
    }
    return this.#current;
  }

  async clickLink(selector: string): Promise<PageSnapshot> {
    const parsed = parseSelector(selector);
    const tag = openingTags(this.#current.body).find((candidate) => selectorMatches(candidate, parsed));
    if (tag === undefined) {
      throw new Error(`the link ${selector} is not rendered on the current page`);
    }
    const href = attributesOf(tag).get("href");
    if (href === undefined) {
      throw new Error(`the matched ${selector} element has no href`);
    }
    this.#current = await this.#load(this.#resolveHref(href));
    return this.#current;
  }

  async pressEnterIn(): Promise<PageSnapshot> {
    throw new DriverCapabilityUnavailable("pressEnterIn", this.capabilities.label);
  }

  async tabStops(): Promise<readonly TabStop[]> {
    throw new DriverCapabilityUnavailable("tabStops", this.capabilities.label);
  }

  async measureTargets(): Promise<readonly TargetMeasure[]> {
    throw new DriverCapabilityUnavailable("measureTargets", this.capabilities.label);
  }

  async isDisplayed(): Promise<boolean> {
    throw new DriverCapabilityUnavailable("isDisplayed", this.capabilities.label);
  }

  async close(): Promise<void> {
    this.#cookies.clear();
  }

  // --- internals -----------------------------------------------------------

  #formFieldState(formSelector: string): Map<string, string[]> {
    let state = this.#formState.get(formSelector);
    if (state === undefined) {
      state = new Map<string, string[]>();
      this.#formState.set(formSelector, state);
    }
    return state;
  }

  #locateForm(formSelector: string): FormBlock | undefined {
    const parsed = parseSelector(formSelector);
    return formBlocks(this.#current.body).find((block) => selectorMatches(block.openTag, parsed));
  }

  /** Hidden rendered fields + selects' first option + driver-typed fields. */
  #encodeForm(block: FormBlock, formSelector: string): string {
    const fields = new Map<string, string[]>();
    for (const input of block.html.matchAll(/<input\b[^>]*>/g)) {
      const attrs = attributesOf(input[0]);
      const name = attrs.get("name");
      if (name === undefined) continue;
      const type = (attrs.get("type") ?? "text").toLowerCase();
      if (type === "hidden") {
        fields.set(name, [...(fields.get(name) ?? []), attrs.get("value") ?? ""]);
      }
    }
    for (const select of block.html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)) {
      const openTag = (select[0].match(/<select\b[^>]*>/) ?? ["<select>"])[0];
      const attrs = attributesOf(openTag);
      const name = attrs.get("name");
      if (name === undefined) continue;
      const option = [...(select[1] ?? "").matchAll(/<option\b[^>]*>/g)]
        .map((optionTag) => attributesOf(optionTag[0]))
        .find((optionAttrs) => optionAttrs.has("value"));
      if (option !== undefined) fields.set(name, [...(fields.get(name) ?? []), option.get("value") ?? ""]);
    }
    const typed = this.#formState.get(formSelector);
    if (typed !== undefined) {
      for (const [name, values] of typed) {
        fields.set(name, [...values]);
      }
    }
    const pairs: string[] = [];
    for (const [name, values] of fields) {
      for (const value of values) pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
    return pairs.join("&");
  }

  #resolveHref(href: string): string {
    if (href.startsWith("/")) return `${this.#origin}${href}`;
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    return new URL(href, this.#current.url).toString();
  }

  async #load(
    target: string,
    options?: { readonly method?: "POST"; readonly body?: string },
  ): Promise<PageSnapshot> {
    let url = target;
    for (let hop = 0; hop < 10; hop += 1) {
      const headers: Record<string, string> = {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "RoamLink-PA021-acceptance/1.0 (offline fake driver)",
      };
      if (this.#cookies.size > 0) {
        headers["cookie"] = [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
      }
      if (options?.method === "POST") {
        headers["content-type"] = "application/x-www-form-urlencoded";
        headers["origin"] = this.#origin;
        headers["referer"] = this.#current.url;
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method: options?.method ?? "GET",
          headers,
          ...(options?.body !== undefined ? { body: options.body } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        return {
          url,
          status: 0,
          body: "",
          failed: true,
          failureDetail: error instanceof Error ? error.message : "network failure",
          navigated: false,
        };
      }
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(";");
        if (pair === undefined) continue;
        const separator = pair.indexOf("=");
        if (separator > 0) this.#cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        if (location !== null) {
          url = this.#resolveHref(location);
          continue;
        }
      }
      const body = await response.text();
      return { url, status, body, failed: false, navigated: true };
    }
    return { url, status: 0, body: "", failed: true, failureDetail: "too many redirects", navigated: false };
  }
}

/** The offline fake driver (deterministic; loopback fixtures only). */
export function createFakeDriver(origin: string): BrowserDriver {
  const capabilities: DriverCapabilities = {
    label: "offline-fake-driver (fetch + document scanners)",
    layout: false,
    keyboard: false,
    realBrowser: false,
  };
  return {
    capabilities,
    async openContext(viewport: Viewport): Promise<BrowserContext> {
      return new FakeBrowserContext(origin, viewport);
    },
    async close(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// The real Playwright driver
//
// The playwright MODULE is a dev dependency of this package (importing it
// never launches a browser); the BROWSER BINARY availability is probed by
// `probeBrowserAvailability` and owned honestly by the callers (the
// selftest records a named skip; the CLI fails with the reason).
// ---------------------------------------------------------------------------

function chromiumDriverLabel(browser: Browser): string {
  return `playwright chromium ${browser.version()} (headless)`;
}

/**
 * Probes whether a real headless Chromium can launch (the dev dependency
 * installed AND the browser binary present). Returns the launch failure's
 * message on failure — the caller records the named skip, never a fake pass.
 */
export async function probeBrowserAvailability(): Promise<
  { readonly ok: true; readonly label: string } | { readonly ok: false; readonly reason: string }
> {
  try {
    const browser = await chromium.launch({ headless: true });
    const label = chromiumDriverLabel(browser);
    await browser.close();
    return { ok: true, label };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "the playwright/chromium launch failed" };
  }
}

/** The real-browser context over one Playwright page. */
class PlaywrightContext implements BrowserContext {
  readonly capabilities: DriverCapabilities;

  readonly #page: Page;
  readonly #origin: string;
  readonly #viewport: Viewport;
  readonly #timeoutMs: number;
  #lastStatus = 200;

  constructor(
    page: Page,
    origin: string,
    viewport: Viewport,
    timeoutMs: number,
    label: string,
  ) {
    this.#page = page;
    this.#origin = origin;
    this.#viewport = viewport;
    this.#timeoutMs = timeoutMs;
    this.capabilities = { label, layout: true, keyboard: true, realBrowser: true };
  }

  get viewport(): Viewport {
    return this.#page.viewportSize() ?? this.#viewport;
  }

  async goto(path: string): Promise<PageSnapshot> {
    const url = new URL(path, this.#origin).toString();
    const response = await this.#page.goto(url, {
      timeout: this.#timeoutMs,
      waitUntil: "domcontentloaded",
    });
    this.#lastStatus = response?.status() ?? this.#lastStatus;
    await this.#settle();
    return this.snapshot();
  }

  async snapshot(): Promise<PageSnapshot> {
    return {
      url: this.#page.url(),
      status: this.#lastStatus,
      body: await this.#page.content(),
      failed: false,
      navigated: true,
    };
  }

  async count(selector: string): Promise<number> {
    return this.#page.locator(selector).count();
  }

  async attr(selector: string, attribute: string): Promise<string | null> {
    const locator = this.#page.locator(selector).first();
    if ((await locator.count()) === 0) return null;
    return locator.getAttribute(attribute);
  }

  async attrAll(selector: string, attribute: string): Promise<readonly string[]> {
    return this.#page.locator(selector).evaluateAll((elements, name) =>
      elements.map((element) => element.getAttribute(name)).filter((value): value is string => value !== null),
    attribute);
  }

  async contentMatches(pattern: RegExp): Promise<boolean> {
    return pattern.test(await this.#page.content());
  }

  async headings(): Promise<readonly HeadingNode[]> {
    const raw = await this.#page.evaluate(() => {
      const nodes: { tag: string; text: string }[] = [];
      for (const element of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
        nodes.push({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        });
      }
      return nodes;
    });
    return raw.map((node) => ({
      tag: node.tag as HeadingNode["tag"],
      text: node.text,
    }));
  }

  async fillText(formSelector: string, name: string, value: string): Promise<void> {
    await this.#page
      .locator(`${formSelector} input[name="${name}"]:not([type="hidden"])`)
      .first()
      .fill(value, { timeout: this.#timeoutMs });
  }

  async selectOption(formSelector: string, name: string, value: string): Promise<void> {
    await this.#page
      .locator(`${formSelector} select[name="${name}"]`)
      .first()
      .selectOption(value, { timeout: this.#timeoutMs });
  }

  async check(formSelector: string, name: string, value: string): Promise<void> {
    await this.#page
      .locator(`${formSelector} input[name="${name}"][value="${value}"]`)
      .first()
      .check({ timeout: this.#timeoutMs });
  }

  async submit(formSelector: string): Promise<PageSnapshot> {
    const button = this.#page
      .locator(`${formSelector} button[type="submit"], ${formSelector} button:not([type])`)
      .first();
    if ((await button.count()) === 0) {
      throw new Error(
        `the form ${formSelector} has no submit button on the current page (never submit an unrendered form)`,
      );
    }
    return this.#navigateWith(() => button.click({ timeout: this.#timeoutMs }), false);
  }

  async clickLink(selector: string): Promise<PageSnapshot> {
    const link = this.#page.locator(selector).first();
    if ((await link.count()) === 0) {
      throw new Error(`the link ${selector} is not rendered on the current page`);
    }
    return this.#navigateWith(() => link.click({ timeout: this.#timeoutMs }), false);
  }

  async pressEnterIn(formSelector: string): Promise<PageSnapshot> {
    const field = this.#page
      .locator(
        `${formSelector} input[type="text"], ${formSelector} input[type="email"], ${formSelector} input[type="password"], ${formSelector} select`,
      )
      .first();
    if ((await field.count()) === 0) {
      throw new Error(`the form ${formSelector} has no focusable text control`);
    }
    await field.focus({ timeout: this.#timeoutMs });
    return this.#navigateWith(() => this.#page.keyboard.press("Enter"), true);
  }

  async tabStops(stops: number): Promise<readonly TabStop[]> {
    const collected: TabStop[] = [];
    for (let index = 0; index < stops; index += 1) {
      await this.#page.keyboard.press("Tab");
      const stop = await this.#page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || !(element instanceof HTMLElement)) return null;
        const isBody = element === document.body;
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const style = window.getComputedStyle(element);
        const outlineStyle = style.outlineStyle;
        const outlineWidth = style.outlineWidth;
        const outlineColor = style.outlineColor;
        const boxShadow = style.boxShadow;
        const indicator =
          (outlineStyle !== "none" && (outlineStyle === "auto" || Number.parseFloat(outlineWidth) > 0)) ||
          (boxShadow !== undefined && boxShadow !== "none");
        const name = element.getAttribute("name");
        const flow = element.getAttribute("data-flow");
        const description =
          `<${element.tagName.toLowerCase()}` +
          (element.id !== "" ? ` id=${element.id}` : "") +
          (name !== null ? ` name=${name}` : "") +
          (flow !== null ? ` data-flow=${flow}` : "") +
          `> ${(element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
        return {
          description,
          isBody,
          visible,
          focusIndicator: indicator,
          focusDetail: `outline: ${outlineStyle} ${outlineWidth} ${outlineColor}; box-shadow: ${boxShadow}`,
        };
      });
      if (stop !== null) collected.push(stop);
    }
    // The wrap point (body focus after the last focusable element) is the
    // browser's own behavior, not the page's interaction contract: body
    // stops are excluded from the sample (a page with ZERO non-body stops
    // still fails — no keyboard-reachable content).
    return collected.filter((stop) => !stop.isBody);
  }

  async measureTargets(selectors: readonly string[]): Promise<readonly TargetMeasure[]> {
    return this.#page.evaluate((selectorList: string[]) => {
      const measures: { selector: string; description: string; width: number; height: number }[] = [];
      for (const selector of selectorList) {
        for (const element of document.querySelectorAll(selector)) {
          if (!(element instanceof HTMLElement)) continue;
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          measures.push({
            selector,
            description: `<${element.tagName.toLowerCase()}> ${(element.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 48)}`,
            width: rect.width,
            height: rect.height,
          });
        }
      }
      return measures;
    }, [...selectors]);
  }

  async isDisplayed(selector: string): Promise<boolean> {
    const locator = this.#page.locator(selector).first();
    if ((await locator.count()) === 0) return false;
    return locator.isVisible();
  }

  async close(): Promise<void> {
    await this.#page.close();
  }

  // --- internals -----------------------------------------------------------

  async #settle(): Promise<void> {
    // Server-rendered documents arrive complete; a short settle covers the
    // document's own parse. No network wait-for-idle (nothing async loads).
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  async #navigateWith(
    trigger: () => Promise<void>,
    tolerateNoNavigation: boolean,
  ): Promise<PageSnapshot> {
    const before = this.#page.url();
    const beforeContent = await this.#page.content();
    let failure: unknown = null;
    let navigationStatus: number | null = null;
    await Promise.all([
      this.#page
        .waitForNavigation({ timeout: Math.min(this.#timeoutMs, 20_000) })
        .then((response) => {
          navigationStatus = response?.status() ?? null;
        })
        .catch((error: unknown) => {
          failure = error;
        }),
      trigger().catch((error: unknown) => {
        failure = error;
      }),
    ]);
    try {
      await this.#page.waitForLoadState("domcontentloaded", { timeout: Math.min(this.#timeoutMs, 20_000) });
    } catch {
      // The document already arrived; proceed with the current content.
    }
    await this.#settle();
    const afterUrl = this.#page.url();
    const afterContent = await this.#page.content();
    const navigated = afterUrl !== before || afterContent !== beforeContent;
    if (failure !== null && !navigated && !tolerateNoNavigation) {
      throw failure instanceof Error ? failure : new Error("the navigation action failed");
    }
    if (navigationStatus !== null) this.#lastStatus = navigationStatus;
    return { url: afterUrl, status: this.#lastStatus, body: afterContent, failed: false, navigated };
  }
}

/** Creates the real Playwright driver; throws when the launch fails. */
export async function createPlaywrightDriver(origin: string): Promise<BrowserDriver> {
  const browser = await chromium.launch({ headless: true });
  const label = chromiumDriverLabel(browser);
  return {
    capabilities: { label, layout: true, keyboard: true, realBrowser: true },
    async openContext(viewport: Viewport, timeoutMs: number): Promise<BrowserContext> {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      return new PlaywrightContext(page, origin, viewport, timeoutMs, label);
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}
