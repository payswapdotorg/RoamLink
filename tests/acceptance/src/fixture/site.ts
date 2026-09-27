/**
 * The offline dummy local fixture (PA-021 selftest).
 *
 * A loopback-only node:http site that speaks the PORTAL'S marker vocabulary
 * (the data-attribute contracts the deployed surface renders: the shell
 * contract, the mutation-result panels, the PA-020 quiet degradation
 * panels, the onboarding wizard forms, the demo quick-action login). The
 * selftest drives the REAL runner machinery — journeys, levels, honest
 * stops, mutation submissions through the flow plane, report emission —
 * against this fixture with BOTH drivers (the offline fake driver always;
 * the real Playwright browser when the box has one).
 *
 * The fixture MIRRORS the measured live terrain, it never claims to BE the
 * product:
 *  - login is real (roster + httpOnly cookie);
 *  - the devices read model holds ONE pre-executed fixture device (so the
 *    device-detail / SIM / create-goal journeys have something to walk);
 *  - enroll-device / esim-enable / create-support-case answer the typed
 *    ACCEPTED acknowledgement (accepted stage reached, later stages
 *    honestly not reached — the multi-tick truth of the real runtime);
 *  - create-intent is the one flow the fixture's tiny "worker" executes
 *    immediately, so the machinery exercises the mutation-executed AND
 *    user-visible-evidence levels end to end;
 *  - esim-install answers the typed refusal (the honest pre-parity
 *    terrain); activate-intent answers the honest read-first refusal;
 *  - the notification-derived sections render the PA-020 quiet panel;
 *    /commerce renders the page-level fail-closed typed panel;
 *    /workspace degrades its enterprise read; /admin + /ops/slo render the
 *    access-denied gate for every persona.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** The fixture's public demo roster (mirrors the portal's public fixtures). */
const ROSTER: ReadonlyArray<{ readonly key: string; readonly email: string; readonly password: string }> = [
  { key: "customer", email: "customer@demo.roamlink.example", password: "roamlink-demo" },
  { key: "owner", email: "owner@demo.roamlink.example", password: "roamlink-demo" },
  { key: "member", email: "member@demo.roamlink.example", password: "roamlink-demo" },
];

const FIXTURE_DEVICE_ID = "dev-fixture-1";

/** The fixture's a11y-shaped shell + page CSS (the 44px floor, focus-visible). */
const FIXTURE_STYLES = `
body { background: #faf8f5; color: #2d2a26; font-family: system-ui, sans-serif; margin: 0; }
.shell-skip-link { position: absolute; left: -999px; top: 0; background: #fff; padding: 0.6rem 1rem; z-index: 10; border: 2px solid #2d2a26; }
.shell-skip-link:focus { left: 0.5rem; top: 0.5rem; }
.shell-header { background: #fffdf9; border-bottom: 1px solid #e8e2da; }
.shell-header-inner { max-width: 72rem; margin: 0 auto; padding: 0.7rem 1.25rem; display: flex; gap: 1.5rem; align-items: center; justify-content: space-between; }
.shell-title-wrap { margin: 0; font-size: 1.15rem; }
.shell-title { color: #2d2a26; text-decoration: none; }
.shell-body { max-width: 72rem; margin: 0 auto; padding: 1.25rem; display: block; }
.shell-sidebar { display: none; }
.shell-bottom-nav { display: none; }
.shell-footer { border-top: 1px solid #e8e2da; margin-top: 3rem; }
.shell-footer-inner { padding: 0.8rem 1.25rem; color: #8a8078; }
button { min-height: 44px; padding: 0.5rem 1.1rem; cursor: pointer; }
form input[type="text"], form input[type="email"], form input[type="password"], form select { min-height: 44px; box-sizing: border-box; }
details summary { min-height: 44px; box-sizing: border-box; cursor: pointer; }
.goal-card a { display: inline-flex; align-items: center; min-height: 44px; }
.preference-option { display: flex; align-items: center; gap: 0.55rem; min-height: 44px; box-sizing: border-box; }
.demo-account-button { display: block; width: 100%; text-align: left; min-height: 44px; padding: 0.7rem 0.9rem; }
@media (min-width: 56rem) {
  .shell-body { display: grid; grid-template-columns: 13rem minmax(0, 1fr); gap: 2.5rem; }
  .shell-sidebar { display: block; }
  .shell-sidebar-nav ul { list-style: none; margin: 1.25rem 0 0; padding: 0; }
  .shell-sidebar-nav a { display: flex; align-items: center; min-height: 44px; padding: 0.5rem 0.75rem; }
}
@media (max-width: 55.99rem) {
  .shell-bottom-nav { display: block; position: sticky; bottom: 0; background: #fffdf9; border-top: 1px solid #e8e2da; }
  .shell-bottom-nav ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, 1fr); }
  .shell-bottom-nav a { display: flex; align-items: center; justify-content: center; min-height: 48px; }
}
:focus-visible { outline: 3px solid #b07f3e; outline-offset: 2px; }
.panel { border: 1px solid #e8e2da; background: #fff; padding: 1rem; margin: 1rem 0; }
.panel.error { border-color: #b91c1c; }
.muted { color: #8a8078; }
`.trim();

interface FixtureGoal {
  readonly intentId: string;
  readonly rationale: string;
}

interface FixtureSession {
  readonly persona: string;
  readonly goals: FixtureGoal[];
  caseCount: number;
}

interface FixtureState {
  sessions: Map<string, FixtureSession>;
  commandCounter: number;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function documentOf(title: string, mainBody: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${FIXTURE_STYLES}</style></head><body>
<a class="shell-skip-link" href="#shell-main">Skip to content</a>
<header class="shell-header"><div class="shell-header-inner">
<h1 class="shell-title-wrap"><a class="shell-title" href="/">RoamLink</a></h1>
<div class="shell-header-status"><div class="shell-indicator" data-shell-connectivity="no-reference" role="status"><p class="shell-indicator-headline"><span class="shell-indicator-label">No active connectivity reference</span></p></div></div>
</div></header>
<div class="shell-body"><aside class="shell-sidebar"><nav class="shell-sidebar-nav" aria-label="Primary"><ul>
<li><a href="/">Home</a></li><li><a href="/connectivity">Connectivity</a></li><li><a href="/activity">Activity</a></li><li><a href="/devices">Devices</a></li><li><a href="/intents">Goals</a></li>
</ul></nav></aside>
<main id="shell-main" class="shell-main">
${mainBody}
</main></div>
<nav class="shell-bottom-nav" aria-label="Primary mobile"><ul>
<li><a href="/">Home</a></li><li><a href="/connectivity">Connect</a></li><li><a href="/activity">Activity</a></li><li><a href="/devices">Devices</a></li><li><a href="/more">More</a></li>
</ul></nav>
<footer class="shell-footer"><div class="shell-footer-inner">RoamLink offline fixture (PA-021 selftest) - mirrors the portal marker vocabulary; never the product.</div></footer>
</body></html>`;
}

function loginDocumentOf(): string {
  const quickActions = ROSTER.map(
    (persona) => `<form method="POST" action="/auth/session" class="demo-account-form" data-demo-account="${persona.key}">
<input type="hidden" name="email" value="${persona.email}">
<input type="hidden" name="password" value="${persona.password}">
<button type="submit" class="demo-account-button"><span class="demo-account-name">Demo ${persona.key}</span></button>
</form>`,
  ).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RoamLink - Sign in</title><style>${FIXTURE_STYLES}</style></head><body>
<header class="site"><div class="inner"><h1>RoamLink</h1></div></header>
<main>
<h2>Sign in</h2>
<p class="muted">The fixture login document.</p>
<h2>Demo accounts</h2>
<div class="demo-accounts" data-demo-accounts="true">
${quickActions}
</div>
<form method="POST" action="/auth/session">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">Sign in</button>
</form>
</main>
<footer class="site"><div class="inner">RoamLink offline fixture (PA-021 selftest)</div></footer>
</body></html>`;
}

function stagesOf(commandId: string, executed: boolean): string {
  const stage = (name: string, reached: boolean, description: string): string =>
    `<li data-stage="${name}" data-reached="${reached ? "true" : "false"}"><strong>${name}</strong> - ${description} ${reached ? "at 2026-09-27T00:00:00Z" : '<span class="muted">(not reached yet)</span>'}</li>`;
  return `<ol class="stages" data-command-id="${commandId}">
${stage("accepted", true, "the command was accepted by the boundary")}
${stage("executed", executed, "RoamLink applied the command to its own state")}
${stage("delivered", false, "delivery evidence was linked for the affected subject")}
${stage("billable-final", false, "commerce finality was reached (e.g. the invoice reconciled)")}
</ol>`;
}

function ackPanelOf(commandId: string, idempotencyKey: string, executed: boolean): string {
  return `<div class="panel ok" data-mutation-result="ok" data-command-id="${commandId}">
<h2>Command acknowledged</h2>
<p class="muted">command ${commandId} (idempotency key ${idempotencyKey}, correlation ${commandId}-corr)</p>
${stagesOf(commandId, executed)}
</div>`;
}

function errorPanelOf(kind: string, reason: string, message: string): string {
  return `<div class="panel error" data-mutation-result="error" data-error-kind="${kind}" data-error-reason="${reason}">
<h2>The request failed</h2>
<p>${message} (${kind} / ${reason})</p>
<p class="muted">This failure is not retryable as-is.</p>
</div>`;
}

function quietPanelOf(section: string, reason: string): string {
  return `<div class="panel" data-unavailable="true" data-unavailable-section="${section}" data-unavailable-reason="${reason}">
<h3>Not available right now</h3>
<p>This section's source did not answer: <code>${reason}</code>.</p>
<p class="muted">The rest of this page still renders its authoritative facts.</p>
</div>`;
}

function homeBody(): string {
  return `<h2>Home</h2>
<section data-connectivity-overview="true" data-presented-at="2026-09-27T00:00:00Z"><p class="muted">Presented at 2026-09-27T00:00:00Z.</p><div class="panel" data-empty="true">No connectivity subjects to show.</div></section>
<h2>Does RoamLink need you?</h2>
${quietPanelOf("home-attention", "READ_MODEL_NOT_COMPOSED")}
<h2>Your devices</h2>
<ul class="goal-list" data-devices="true" aria-label="Your devices"><li class="goal-card" data-device-id="${FIXTURE_DEVICE_ID}"><h3>Fixture Phone</h3><p class="muted">iPhone / iPad</p></li></ul>`;
}

function connectivityBody(): string {
  return `<h2>Connectivity</h2>
<section data-connectivity-overview="true" data-presented-at="2026-09-27T00:00:00Z"><h2>What your devices are seeing</h2><p class="muted">Presented at 2026-09-27T00:00:00Z.</p><div class="panel" data-empty="true">No connectivity subjects to show.</div></section>
<details class="disclosure" data-disclosure="why"><summary>Why this is happening</summary><p>Nothing is being managed right now.</p></details>
<details class="disclosure" data-disclosure="evidence"><summary>The evidence behind this</summary><p>No delivery evidence is linked yet.</p></details>
<details class="disclosure" data-disclosure="technical"><summary>Technical detail</summary><p>subjects=[] deviceObservations=[]</p></details>
<h2>Recent connectivity events</h2>
${quietPanelOf("connectivity-events", "READ_MODEL_NOT_COMPOSED")}`;
}

function activityBody(): string {
  return `<h2>Activity</h2>
<h2>Automation status</h2>
<p class="muted">No goals are being worked on yet.</p>
<h2>What RoamLink did</h2>
${quietPanelOf("activity-timeline", "READ_MODEL_NOT_COMPOSED")}
<h2>Does RoamLink need you?</h2>
${quietPanelOf("activity-needs-you", "READ_MODEL_NOT_COMPOSED")}`;
}

function devicesBody(ack: string): string {
  return `${ack}
<h2>Devices</h2>
<ul class="goal-list" data-devices="true" aria-label="Your devices">
<li class="goal-card" data-device-id="${FIXTURE_DEVICE_ID}"><h3>Fixture Phone</h3><p class="muted">iPhone / iPad</p><p><a href="/devices/${FIXTURE_DEVICE_ID}">Open this device</a></p></li>
</ul>
<h2>Add a device</h2>
<form method="POST" action="/flows/enroll-device" data-flow="enroll-device">
<label for="enroll-name">Name</label><input type="text" name="name" id="enroll-name" required>
<label for="enroll-platform">Kind of device</label>
<select name="platform" id="enroll-platform"><option value="ios">iPhone / iPad</option><option value="android">Android</option><option value="macos">Mac</option></select>
<button type="submit">Add device</button>
</form>`;
}

function deviceDetailBody(deviceId: string): string {
  return `<h2>Fixture Phone</h2>
<section class="panel" data-device-capability="true" data-capability-state="FRESH">
<h3>What this device can do</h3>
<p>Certified capability set - verified fresh.</p>
</section>
<p><a href="/devices/${deviceId}/sim">SIM and profiles</a></p>
<form method="POST" action="/flows/update-device" data-flow="update-device">
<input type="hidden" name="deviceId" value="${deviceId}">
<label for="device-name">Name</label><input type="text" name="name" id="device-name">
<button type="submit">Save</button>
</form>`;
}

function simBody(deviceId: string, panel: string): string {
  return `${panel}
<h2>SIM and profiles</h2>
<section class="panel" data-esim-install="true">
<h3>Install a new profile</h3>
<form method="POST" action="/flows/esim-install" data-flow="esim-install">
<input type="hidden" name="deviceId" value="${deviceId}">
<label for="esim-activation-code">Activation code</label>
<input type="text" name="activationCode" id="esim-activation-code" required autocomplete="off">
<button type="submit">Install profile</button>
</form>
</section>
<ul class="goal-list" data-esim-profiles="true" aria-label="eSIM profiles">
<li class="goal-card" data-esim-profile-id="profile-1">
<h3>Fixture profile</h3>
<form method="POST" action="/flows/esim-enable" data-flow="esim-enable">
<input type="hidden" name="deviceId" value="${deviceId}">
<input type="hidden" name="profileId" value="profile-1">
<input type="hidden" name="enabled" value="true">
<button type="submit">Enable this profile</button>
</form>
<form method="POST" action="/flows/esim-remove" data-flow="esim-remove">
<input type="hidden" name="deviceId" value="${deviceId}">
<input type="hidden" name="profileId" value="profile-1">
<button type="submit">Remove this profile</button>
</form>
</li>
</ul>`;
}

function intentsBody(session: FixtureSession, ack: string): string {
  const cards = session.goals
    .map(
      (goal) => `<li class="goal-card" data-intent-id="${goal.intentId}">
<h3>${escapeHtml(goal.rationale)}</h3>
<form method="POST" action="/flows/activate-intent" data-flow="activate-intent">
<input type="hidden" name="intentId" value="${goal.intentId}">
<button type="submit">Activate this goal</button>
</form>
</li>`,
    )
    .join("\n");
  return `${ack}
<h2>Goals</h2>
${session.goals.length === 0 ? '<div class="panel" data-goals-empty="true"><p>No goals yet.</p></div>' : `<ul class="goal-list" data-intents="true" aria-label="Your goals">${cards}</ul>`}
<h2>Add a goal</h2>
<form method="POST" action="/flows/create-intent" data-flow="create-intent">
<label for="goal-device">For which device?</label>
<select name="deviceId" id="goal-device"><option value="${FIXTURE_DEVICE_ID}">Fixture Phone (ios)</option></select>
<label for="goal-rationale">In your own words, what do you want?</label>
<input type="text" name="rationale" id="goal-rationale" required>
<fieldset class="preference-list"><legend>What matters most about this goal?</legend>
<label class="preference-option"><input type="checkbox" name="accessClasses" value="any_internet"><span>Full internet when you need it</span></label>
<label class="preference-option"><input type="checkbox" name="accessClasses" value="work_apps_only"><span>Work apps stay reachable</span></label>
</fieldset>
<button type="submit">Create this goal</button>
</form>`;
}

function supportBody(ack: string, caseCount: number, carried: { readonly about: string; readonly detail: string | null } | null): string {
  return `${ack}
<h2>Support</h2>
${carried === null ? "" : `<section class="panel" data-carried-support-context="true"><h3>What will be attached</h3><p>Subject carried from the page you came from: ${escapeHtml(carried.about)}</p></section>`}
${caseCount === 0 ? '<div class="panel" data-empty="true">No support cases to show.</div>' : `<ul data-support-cases="true">${Array.from({ length: caseCount }, (_, index) => `<li data-case-id="case-${index + 1}"><h3>case-${index + 1}</h3><p><a href="/support/case-${index + 1}">Open case-${index + 1}</a></p></li>`).join("")}</ul>`}
<h2>Open a support case</h2>
<form method="POST" action="/flows/create-support-case" data-flow="create-support-case">
<label for="case-subject">Subject${carried === null ? "" : " (carried from the page you came from)"}</label><input type="text" name="subject" id="case-subject" required${carried === null ? "" : ` value="${escapeHtml(carried.about)}"`}>
<label for="case-description">Description</label><input type="text" name="description" id="case-description" required>
<label for="case-priority">Priority</label>
<select name="priority" id="case-priority"><option value="low">low</option><option value="normal">normal</option><option value="high">high</option><option value="urgent">urgent</option></select>
${carried === null ? "" : `<input type="hidden" name="relatedRef" value="device~dev-fixture-1" data-related-ref-kind="device" data-related-ref-id="dev-fixture-1">`}
<button type="submit">Open case</button>
<p class="muted" data-support-context-note="${carried === null ? "false" : "true"}">${carried === null ? "Nothing is attached automatically from this form." : "Opening this case attaches the references listed above so support sees the same facts you see."}</p>
</form>`;
}

function caseThreadBody(caseId: string): string {
  return `<h2>Support case ${escapeHtml(caseId)}</h2>
<ul data-case-thread="true"><li><p>The customer-visible thread for ${escapeHtml(caseId)}.</p></li></ul>`;
}

function workspaceBody(): string {
  return `<h2>Workspace</h2>
<h2>Device fleet</h2>
<ul class="goal-list" data-devices="true"><li class="goal-card" data-device-id="${FIXTURE_DEVICE_ID}"><h3>Fixture Phone</h3></li></ul>
<h2>Active goals</h2>
${quietPanelOf("workspace-read", "ROUTE_NOT_COMPOSED")}
<h2>Connector enrollment</h2>
${quietPanelOf("workspace-connector", "ROUTE_NOT_COMPOSED")}`;
}

function commerceBody(): string {
  return `<h2>Plans and billing</h2>
${errorPanelOf("unavailable", "READ_MODEL_NOT_COMPOSED", "the products, orders and subscriptions read models are not composed on this runtime")}`;
}

function accessDeniedBody(): string {
  return `<h2>RoamLink Ops</h2>
<div class="panel error" data-access-denied="true" data-required-permission="org:read">
<h3>Access denied</h3>
<p>This ops surface requires the 'org:read' permission.</p>
<p class="muted">Authorization is enforced by the API; this decision is final for this session.</p>
</div>`;
}

function moreBody(): string {
  return `<h2>More</h2><ul><li><a href="/intents">Goals</a></li><li><a href="/commerce">Plans and billing</a></li><li><a href="/support">Support</a></li><li><a href="/settings">Settings</a></li></ul>`;
}

function settingsBody(): string {
  return `<h2>Settings</h2><p class="muted">Session preferences.</p>`;
}

function onboardingBody(step: string, goal: string | null): string {
  if (step === "welcome") {
    return `<div class="onboarding" data-onboarding="true" data-onboarding-step="welcome">
<h2>Welcome to RoamLink</h2>
<p><a class="onboarding-primary-action" href="/onboarding?step=goal">Get started</a></p>
</div>`;
  }
  if (step === "goal") {
    return `<div class="onboarding" data-onboarding="true" data-onboarding-step="goal">
<h2>What do you want your connectivity to do for you?</h2>
<form method="get" action="/onboarding" data-onboarding-form="choose-goal">
<input type="hidden" name="step" value="device">
<fieldset class="onboarding-goal-list"><legend class="sr-only">Connectivity goal</legend>
<label class="onboarding-goal"><input type="radio" name="goal" value="travel" required><span>Stay connected while traveling</span></label>
<label class="onboarding-goal"><input type="radio" name="goal" value="work" required><span>Keep work reliable</span></label>
</fieldset>
<button type="submit" class="onboarding-primary-action">Continue</button>
</form>
</div>`;
  }
  if (step === "device") {
    return `<div class="onboarding" data-onboarding="true" data-onboarding-step="device">
<h2>Where should RoamLink help?</h2>
<form method="get" action="/onboarding" data-onboarding-form="pick-device">
<input type="hidden" name="step" value="preferences">
<input type="hidden" name="goal" value="${goal ?? ""}">
<fieldset class="onboarding-device-list"><legend class="sr-only">Your devices</legend>
<label class="onboarding-device"><input type="radio" name="deviceId" value="${FIXTURE_DEVICE_ID}" required><span>Fixture Phone</span></label>
</fieldset>
<button type="submit" class="onboarding-primary-action">Continue</button>
</form>
<h3>Add a new device</h3>
<form method="post" action="/flows/onboarding-enroll-device" data-onboarding-form="enroll-device">
<input type="hidden" name="goal" value="${goal ?? ""}">
<label for="onboard-device-name">Name</label><input type="text" name="name" id="onboard-device-name" required>
<label for="onboard-device-platform">Kind of device</label>
<select name="platform" id="onboard-device-platform"><option value="ios">iPhone / iPad</option><option value="macos">Mac</option></select>
<button type="submit" class="onboarding-primary-action">Add device</button>
</form>
</div>`;
  }
  return `<div class="onboarding" data-onboarding="true" data-onboarding-step="preferences">
<h2>Confirm and finish</h2>
<dl class="onboarding-confirm" data-onboarding-confirm="true"><dt>Your goal</dt><dd>Stay connected while traveling</dd><dt>Your device</dt><dd>Fixture Phone (iPhone / iPad)</dd></dl>
<form method="post" action="/flows/onboarding-finish" data-onboarding-form="finish">
<input type="hidden" name="goal" value="${goal ?? "travel"}">
<input type="hidden" name="deviceId" value="${FIXTURE_DEVICE_ID}">
<button type="submit" class="onboarding-primary-action">Finish and go to Home</button>
</form>
</div>`;
}

/** Starts the loopback-only fixture site; returns its origin and closer. */
export async function startFixtureSite(): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const state: FixtureState = { sessions: new Map(), commandCounter: 0 };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><h1>fixture failure</h1></body></html>");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const path = url.pathname;
    const method = (request.method ?? "GET").toUpperCase();
    const cookies = parseCookies(request.headers.cookie ?? "");
    const token = cookies.get("fixture_session");
    const session = token === undefined ? undefined : state.sessions.get(token);

    const send = (status: number, body: string, extra?: { readonly setCookie?: string; readonly location?: string }): void => {
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      if (extra?.setCookie !== undefined) headers["set-cookie"] = extra.setCookie;
      if (extra?.location !== undefined) headers["location"] = extra.location;
      response.writeHead(status, headers);
      response.end(body);
    };

    if (method === "GET" && path === "/login") {
      send(200, loginDocumentOf());
      return;
    }

    if (method === "POST" && path === "/auth/session") {
      const form = await readForm(request);
      const email = String(form.get("email") ?? "");
      const password = String(form.get("password") ?? "");
      const persona = ROSTER.find((candidate) => candidate.email === email && candidate.password === password);
      if (persona === undefined) {
        send(200, loginDocumentOf());
        return;
      }
      const newToken = `fst-${state.commandCounter += 1}-${persona.key}`;
      state.sessions.set(newToken, { persona: persona.key, goals: [], caseCount: 0 });
      send(303, "", { setCookie: `fixture_session=${newToken}; Path=/; HttpOnly; SameSite=Lax`, location: "/" });
      return;
    }

    // Everything else requires the session (the host's login-redirect law).
    if (session === undefined) {
      send(303, "", { location: "/login" });
      return;
    }

    if (method === "GET") {
      switch (path) {
        case "/":
          send(200, documentOf("RoamLink - home", homeBody()));
          return;
        case "/connectivity":
          send(200, documentOf("RoamLink - connectivity", connectivityBody()));
          return;
        case "/activity":
          send(200, documentOf("RoamLink - activity", activityBody()));
          return;
        case "/devices":
          send(200, documentOf("RoamLink - devices", devicesBody("")));
          return;
        case `/devices/${FIXTURE_DEVICE_ID}`:
          send(200, documentOf("RoamLink - device", deviceDetailBody(FIXTURE_DEVICE_ID)));
          return;
        case `/devices/${FIXTURE_DEVICE_ID}/sim`:
          send(200, documentOf("RoamLink - sim", simBody(FIXTURE_DEVICE_ID, "")));
          return;
        case "/intents":
          send(200, documentOf("RoamLink - intents", intentsBody(session, "")));
          return;
        case "/support": {
          const about = url.searchParams.get("about");
          const detail = url.searchParams.get("detail");
          const carried = about === null ? null : { about, detail };
          send(200, documentOf("RoamLink - support", supportBody("", session.caseCount, carried)));
          return;
        }
        case "/workspace":
          send(200, documentOf("RoamLink - workspace", workspaceBody()));
          return;
        case "/commerce":
          send(200, documentOf("RoamLink - commerce", commerceBody()));
          return;
        case "/more":
          send(200, documentOf("RoamLink - more", moreBody()));
          return;
        case "/settings":
          send(200, documentOf("RoamLink - settings", settingsBody()));
          return;
        case "/onboarding": {
          const step = url.searchParams.get("step") ?? "welcome";
          send(200, documentOf("RoamLink - onboarding", onboardingBody(step, url.searchParams.get("goal"))));
          return;
        }
        case "/admin":
        case "/ops/slo":
          send(200, documentOf("RoamLink Ops - access denied", accessDeniedBody()));
          return;
        default: {
          const caseMatch = /^\/support\/(case-[a-z0-9-]+)$/.exec(path);
          if (caseMatch !== null) {
            send(200, documentOf("RoamLink - case", caseThreadBody(caseMatch[1] ?? "unknown")));
            return;
          }
          send(404, documentOf("RoamLink - not found", errorPanelOf("not-found", "NOT_FOUND", "there is no page at this path")));
          return;
        }
      }
    }

    if (method === "POST" && path.startsWith("/flows/")) {
      const flow = path.slice("/flows/".length);
      const form = await readForm(request);
      const originHeader = request.headers.origin;
      const host = request.headers.host ?? "127.0.0.1";
      // The host's same-origin CSRF seam: a POST without a same-origin
      // Origin header is refused (mirrors the real seam).
      if (originHeader !== `http://${host}`) {
        send(403, documentOf("RoamLink - refused", errorPanelOf("forbidden", "CSRF_INVALID", "the form submission failed the host's same-origin check")));
        return;
      }
      const commandId = `cmd-fixture-${(state.commandCounter += 1)}`;
      const idempotencyKey = `${flow}-${state.commandCounter}`;

      switch (flow) {
        case "enroll-device":
        case "onboarding-enroll-device":
          send(200, documentOf("RoamLink - devices", devicesBody(ackPanelOf(commandId, idempotencyKey, false))));
          return;
        case "esim-install":
          send(
            200,
            documentOf("RoamLink - sim", simBody(String(form.get("deviceId") ?? FIXTURE_DEVICE_ID), errorPanelOf("unavailable", "ESIM_MUTATION_NOT_COMPOSED", "the live API mutation route table does not include the eSIM install mutation on this runtime"))),
          );
          return;
        case "esim-enable":
          send(200, documentOf("RoamLink - sim", simBody(String(form.get("deviceId") ?? FIXTURE_DEVICE_ID), ackPanelOf(commandId, idempotencyKey, false))));
          return;
        case "create-intent": {
          const intentId = `intent-fixture-${(state.commandCounter += 1)}`;
          session.goals.push({ intentId, rationale: String(form.get("rationale") ?? "goal") });
          send(200, documentOf("RoamLink - intents", intentsBody(session, ackPanelOf(commandId, idempotencyKey, true))));
          return;
        }
        case "activate-intent":
          send(200, documentOf("RoamLink - intents", intentsBody(session, errorPanelOf("not-found", "INTENT_NOT_EXECUTED", "the read-first activation leg refuses to act on a goal that has not executed"))));
          return;
        case "create-support-case":
          session.caseCount += 1;
          send(200, documentOf("RoamLink - support", supportBody(ackPanelOf(commandId, idempotencyKey, false), session.caseCount, null)));
          return;
        case "onboarding-finish":
          send(303, "", { location: "/" });
          return;
        case "esim-remove":
        case "update-device":
        case "retire-device":
        case "place-order":
        case "record-payment":
        case "cancel-order":
        case "provision-connector":
          send(200, documentOf("RoamLink - refused", errorPanelOf("unavailable", "MUTATION_ROUTE_NOT_COMPOSED", `the flow "${flow}" is not composed on this runtime`)));
          return;
        default:
          send(404, documentOf("RoamLink - not found", errorPanelOf("not-found", "FLOW_NOT_FOUND", `the flow "${flow}" is not wired`)));
          return;
      }
    }

    send(405, documentOf("RoamLink - method", errorPanelOf("unknown", "METHOD_NOT_ALLOWED", "the method is not allowed")));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fixture server did not bind a loopback port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return cookies;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve());
  });
  const body = Buffer.concat(chunks).toString("utf8");
  return new URLSearchParams(body);
}
