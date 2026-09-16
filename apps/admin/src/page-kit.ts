/**
 * Small shared page helpers for the admin console (RL-061).
 */
import { el, fragment, text, type HtmlFragment } from "@roamlink/app-kit";

export function pageHeading(title: string, hint?: string): HtmlFragment {
  return fragment(
    el("h2", {}, text(title)),
    hint === undefined ? fragment() : el("p", { class: "muted" }, text(hint)),
  );
}
