# @roamlink/tests-acceptance

The **PA-021 deployed-browser acceptance suite**: a black-box, real-browser
journey matrix against the DEPLOYED `ACCEPTANCE_BASE_URL` — the suite knows
only the URL and the public demo credentials (the demo roster of
spec/deployment.md §6 "demo"; the personas are public fixtures by design),
never the repository internals.

## The honest-level law (why this suite exists)

Every journey leg records **which of the six completion levels it actually
evidenced** (docs/live-journey-runtime-audit §6 — the audit's §4/§6
simulation becomes a repeatable measurement):

| level | evidenced by |
|---|---|
| `route-reachable` | the route answered at all (any HTTP status) |
| `surface-rendered` | the expected document rendered (shell + exactly one h1 + page markers — INCLUDING honest fail-closed bodies and PA-020 quiet panels) |
| `read-available` | the page's core data plane composed (an honest empty state IS an available read) |
| `mutation-accepted` | a rendered form submitted through the real `/flows/*` plane and the typed acknowledgement panel rendered (command id + idempotency key) |
| `mutation-executed` | the executed stage was evidenced on the four-stage pipeline |
| `user-visible-evidence` | the mutation's effect is visible on a subsequent surface visit |

A leg that stops at `mutation-accepted` **PASSES while recording that
level**: the suite never fails a leg for an honest runtime limitation
(the read model not composed, the mutation route missing, the admin gate
denying the persona, the accepted command not executed by the worker
plane), and never passes a leg at a level it did not evidence. The exit
contract is **"no lies"**, not "everything executed".

A leg FAILS only when it cannot evidence its floor: the route never
answered, the document broke the shell contract, or a submitted form
produced NO typed outcome panel. A11y check failures are product-contract
violations and also fail the run (each named).

## Usage

```bash
# the env-gated deployed run (no env → the named skip, exit 0)
ACCEPTANCE_BASE_URL=https://<deployed-origin> pnpm acceptance:deployed

# with explicit credentials (defaults: the public demo roster)
ACCEPTANCE_BASE_URL=... ACCEPTANCE_DEMO_EMAIL=... ACCEPTANCE_DEMO_PASSWORD=... \
  ACCEPTANCE_ADMIN_EMAIL=... pnpm acceptance:deployed

# optional: ACCEPTANCE_TIMEOUT_MS (default 45000), ACCEPTANCE_REPORT_DIR
```

The runner executes the journey matrix at BOTH viewport classes
(desktop 1280x800, mobile 390x844 — the shell's bottom-nav breakpoint)
for the customer persona (login → onboarding → goals → devices → eSIM →
connectivity → activity → plans & billing → support → workspace) and the
owner persona (the admin console + `/ops/slo` + integration health), then
emits:

- a **machine-readable JSON report** (default
  `tests/acceptance/.tmp/acceptance-report-*.json`, gitignored) with every
  leg's level, stop reason, evidence lines, degraded panels and a11y
  outcomes; and
- a **human summary** on stdout (per journey: the furthest level reached +
  the honest stop reasons; the level terrain; the named-stop census; the
  a11y battery counts; the verdict).

Exit codes: `0` every leg evidenced its recorded level (the no-lies
contract) or the env is unconfigured (the named skip); `1` a lie-shaped
defect (an unreachable configured target, an untyped flow answer, a broken
shell contract, an a11y violation) or the browser driver is unavailable on
a configured run; `2` a malformed env invocation.

## The journey matrix

Eleven journeys, ~30 legs each × two viewports, each leg recording its
level honestly (see `src/journeys.ts`): login (document + submit — the
desktop submit goes through keyboard Enter on the credential form, the
mobile submit through the demo quick-action), the onboarding wizard
(welcome → goal → enroll-device → finish), goals (read → create → visible
→ activate), devices (list → detail/capabilities → enroll), eSIM (SIM &
Profiles → install → enable → remove), connectivity (summary → why →
evidence → technical disclosure layers), activity (core + the
notification-derived sections' honest degradation), plans & billing (the
page-level fail-closed terrain or the composed commerce walk), support
(read → contextual escape → create → case thread), workspace (core +
the enterprise secondary degradation + connector), admin (console gate,
SLO, integration health — the fail-closed access-denied panel is the
honest answer for personas without `org:read`).

## The a11y/interaction battery

Runs on every walked page (`src/a11y.ts`): exactly one h1; no
heading-level skips; the skip link on application-shell pages; the mobile
bottom nav (displayed at 390px) and the desktop sidebar; the 44px
touch-target floor over the repo's VERIFIED selector families
(apps/web/test/rl114-extended-a11y.test.ts — buttons, form text/select
controls, disclosure summaries, both nav families, the action-link
families; radios/checkboxes ride their floored labels; the ops console is
honestly scoped out with a named skip); keyboard reachability (a tab-order
sample whose stops are visible) and focus visibility (the computed
indicator on sampled stops); forms submittable via keyboard (the login and
goal-choice submissions go through Enter under the real browser).

## Architecture

- `src/driver.ts` — the `BrowserDriver` interface with TWO
  implementations: the real **Playwright/Chromium driver** (deployed runs;
  layout + keyboard capabilities) and the **offline fake driver** (fetch +
  document-level scanners over the same marker vocabulary; deterministic,
  zero-browser). Capability honesty: layout/keyboard checks record NAMED
  SKIPS on the fake driver — never fake passes.
- `src/fixture/site.ts` — the loopback-only dummy fixture site (the
  selftest's target): portal-shaped pages with the same data-attribute
  contracts, one pre-executed device, accepted-not-executed enrollments,
  one immediately-executing create-intent (so the machinery exercises
  mutation-executed + user-visible-evidence), typed refusals for the
  honest-stop terrain, the PA-020 quiet panels and the admin gate.
- `src/runner.ts` — the orchestration: per viewport × persona contexts,
  relogin discipline (one bounded relogin + navigation retry, both
  counted in the report), the level aggregation, the no-lies verdict.
- `src/cli.ts` — the env-gated CLI (`pnpm acceptance:deployed`).

## The selftest (`pnpm test` inside this package; part of `pnpm check`)

Offline and deterministic — NO deployed URL is ever contacted:

1. **no env → the named skip** (the config law + the real CLI subprocess
   exiting 0 with the named reason);
2. **fixture + fake driver** — the full matrix exercises end to end with
   pinned level expectations per leg (accepted-not-executed stops, typed
   refusals, the fail-closed commerce terrain, the admin gate denial, the
   PA-020 panels, the a11y structural passes + named skips);
3. **fixture + real headless Chromium** (browser-gated: when chromium
   cannot launch on the box, the leg records the named skip and still
   passes — never a fake pass, never a hard fail);
4. **a lying terrain** (a bare stub with no portal markers) — the run
   FAILS with `lies-detected`: the no-lie law's teeth.

No new RUNTIME dependencies: `playwright` and `tsx` are devDependencies of
this package only.
