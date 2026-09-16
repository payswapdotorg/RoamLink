/**
 * Framework-free, typed, XSS-safe HTML rendering (RL-060/061 UI core).
 *
 * Choice recorded for the work items: both apps use THIS tiny typed view core
 * instead of a third-party framework - zero new runtime dependencies, works
 * identically in Node and the browser, and every component is a pure function
 * from parsed API resources to an {@link HtmlFragment}, which makes
 * deterministic component tests trivial (no DOM emulation). The choice does
 * not affect dependency direction (apps -> app-kit -> contracts), so no ADR
 * is required by spec/architecture-lock.md RL-LOCK-020.
 *
 * Safety is STRUCTURAL (RL-LOCK-016 spirit): there is no function that turns
 * a raw string into HTML. Text enters through {@link text} (escaped),
 * attributes through {@link el} (escaped), and nothing else exists.
 */
export interface HtmlFragment {
  /** Pre-escaped, structure-complete HTML. */
  readonly html: string;
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** Escapes a value for safe interpolation as HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export type HtmlChild = HtmlFragment | null | undefined;

export type HtmlAttributeValue = string | number | boolean | undefined;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/**
 * Builds one HTML element. Text children MUST come through {@link text};
 * attribute values are escaped. There is deliberately no raw-HTML escape
 * hatch anywhere in this module.
 */
export function el(
  tag: string,
  attrs: Readonly<Record<string, HtmlAttributeValue>> = {},
  ...children: readonly HtmlChild[]
): HtmlFragment {
  if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
    throw new Error("el: invalid tag name");
  }
  const attrParts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (value === true) {
      attrParts.push(` ${name}`);
      continue;
    }
    if (value === false) continue;
    attrParts.push(` ${name}="${escapeHtml(String(value))}"`);
  }
  const inner = children.map((child) => child?.html ?? "").join("");
  if (VOID_ELEMENTS.has(tag.toLowerCase())) {
    return { html: `<${tag}${attrParts.join("")}>` };
  }
  return { html: `<${tag}${attrParts.join("")}>${inner}</${tag}>` };
}

/** Escapes and wraps a text node (numbers render deterministically). */
export function text(value: string | number | null | undefined): HtmlFragment {
  if (value === null || value === undefined) return { html: "" };
  return { html: escapeHtml(String(value)) };
}

/** Joins fragments (no separator). */
export function fragment(...children: readonly HtmlChild[]): HtmlFragment {
  return { html: children.map((child) => child?.html ?? "").join("") };
}

/** Joins fragments with a separator between them. */
export function joinFragments(
  children: readonly HtmlChild[],
  separator: HtmlFragment,
): HtmlFragment {
  return {
    html: children
      .map((child) => child?.html ?? "")
      .filter((html) => html.length > 0)
      .join(separator.html),
  };
}

/** Renders the full HTML document wrapper. */
export function htmlDocument(title: string, body: HtmlFragment): HtmlFragment {
  return {
    html:
      `<!DOCTYPE html>\n` +
      `<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<title>${escapeHtml(title)}</title>\n` +
      `<style>\n` +
      `:root { color-scheme: light dark; }\n` +
      `body { font-family: system-ui, -apple-system, sans-serif; margin: 0; color: #1a1a1a; background: #fafafa; }\n` +
      `main { max-width: 64rem; margin: 0 auto; padding: 1rem 1.5rem 3rem; }\n` +
      `header.site { border-bottom: 1px solid #ddd; background: #fff; }\n` +
      `header.site .inner { max-width: 64rem; margin: 0 auto; padding: 0.75rem 1.5rem; display: flex; gap: 1rem; align-items: baseline; }\n` +
      `header.site h1 { font-size: 1.1rem; margin: 0; }\n` +
      `nav.tabs { display: flex; gap: 1rem; flex-wrap: wrap; }\n` +
      `nav.tabs a { color: #666; text-decoration: none; font-size: 0.95rem; }\n` +
      `footer.site { margin-top: 3rem; border-top: 1px solid #ddd; background: #fff; }\n` +
      `footer.site .inner { max-width: 64rem; margin: 0 auto; padding: 0.75rem 1.5rem; color: #888; font-size: 0.85rem; }\n` +
      `h2 { font-size: 1.15rem; margin: 1.5rem 0 0.5rem; }\n` +
      `h3 { font-size: 1rem; margin: 1rem 0 0.25rem; }\n` +
      `table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; background: #fff; }\n` +
      `th, td { text-align: left; padding: 0.45rem 0.6rem; border: 1px solid #e2e2e2; font-size: 0.9rem; vertical-align: top; }\n` +
      `th { background: #f1f1f1; }\n` +
      `.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; border: 1px solid transparent; }\n` +
      `.badge[data-freshness="FRESH"] { background: #e6f6ea; color: #14532d; border-color: #b7e4c0; }\n` +
      `.badge[data-freshness="STALE"] { background: #fdf3d7; color: #713f12; border-color: #f2e2ac; }\n` +
      `.badge[data-freshness="UNKNOWN"] { background: #ececec; color: #555; border-color: #ccc; }\n` +
      `.badge[data-evidence="EVIDENCED"] { background: #e6f6ea; color: #14532d; border-color: #b7e4c0; }\n` +
      `.badge[data-evidence="UNEVIDENCED"] { background: #fdeaea; color: #7f1d1d; border-color: #f5c6c6; }\n` +
      `.badge[data-severity="critical"] { background: #fdeaea; color: #7f1d1d; border-color: #f5c6c6; }\n` +
      `.badge[data-severity="warning"] { background: #fdf3d7; color: #713f12; border-color: #f2e2ac; }\n` +
      `.badge[data-severity="info"] { background: #e8f0fb; color: #1e3a5f; border-color: #c4d8ef; }\n` +
      `.badge[data-health="healthy"] { background: #e6f6ea; color: #14532d; border-color: #b7e4c0; }\n` +
      `.badge[data-health="degraded"] { background: #fdf3d7; color: #713f12; border-color: #f2e2ac; }\n` +
      `.badge[data-health="down"] { background: #fdeaea; color: #7f1d1d; border-color: #f5c6c6; }\n` +
      `.muted { color: #777; font-size: 0.85rem; }\n` +
      `.panel { background: #fff; border: 1px solid #e2e2e2; border-radius: 8px; padding: 0.9rem 1rem; margin: 0.5rem 0 1rem; }\n` +
      `.panel.error { border-color: #f5c6c6; background: #fff6f6; }\n` +
      `.panel.ok { border-color: #b7e4c0; background: #f7fcf8; }\n` +
      `.stages { list-style: none; padding: 0; margin: 0.25rem 0; }\n` +
      `.stages li { padding: 0.15rem 0; font-size: 0.9rem; }\n` +
      `.stages li[data-reached="false"] { color: #999; }\n` +
      `code { background: #f0f0f0; padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.85em; }\n` +
      `</style>\n</head>\n<body>\n${body.html}\n</body>\n</html>\n`,
  };
}
