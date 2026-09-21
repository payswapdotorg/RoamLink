/**
 * The device-level eSIM management journey (RL-115-F1 remediation, PA-001;
 * spec/ux-architecture.md §9 + §15, spec/architecture.md §7).
 *
 * The frozen laws this page renders under:
 *
 *  - capability truth is EVIDENCE (RL-LOCK-011): every one of the three
 *    closed eSIM capability names renders its status, evidence class,
 *    freshness and the gate preview — a status row is never a permission;
 *  - a blocked action renders the CLOSED manual-guidance map, never a
 *    disabled mystery (spec/ux-architecture.md §9: "When the OS cannot
 *    perform an action, explain the limitation and present the supported
 *    fallback");
 *  - every mutation rides the desired-state command envelope: the page only
 *    renders forms whose gate allows; the SERVER still gates every command
 *    (defense in depth — an ungated mutation does not exist);
 *  - a requested install is NEVER an installed profile (the central
 *    truthfulness rule): `install-requested`/`remove-requested` carry the
 *    outstanding command, not a platform confirmation — only the evidenced
 *    confirmed states (enabled/disabled with OBSERVED evidence + freshness)
 *    claim anything about the device;
 *  - the four-stage command pipeline renders per-stage (accepted is not
 *    executed, executed is not delivered), never collapsed;
 *  - a failed command carries the contextual support escape (RL-103).
 *
 * Pure functions over parsed read models plus the optional command
 * acknowledgement — exactly the discipline of the order journey page.
 */
import {
  freshnessBadge,
  instantView,
  mutationStages,
  stateBadge,
  el,
  fragment,
  text,
  type DeviceResource,
  type DeviceSimResource,
  type EsimCapabilityRowResource,
  type EsimProfileResource,
  type HtmlFragment,
  type MutationAcknowledgement,
  type MutationFlowResult,
} from "@roamlink/app-kit";

import { pagePath } from "../routes.js";
import { pageHeading, tableWrap } from "../app.js";
import {
  ESIM_CAPABILITY_STATUS_LANGUAGE,
  ESIM_GATE_LANGUAGE,
  ESIM_PROFILE_STATE_LANGUAGE,
  MANUAL_FALLBACK_GUIDANCE,
  esimManualGuidanceFor,
} from "./language.js";
import { supportEscape } from "./support-context.js";

export interface SimProfilesPageInput {
  readonly device: DeviceResource;
  readonly sim: DeviceSimResource;
  /**
   * The last eSIM command's acknowledgement (the four-stage pipeline),
   * when the caller knows the command. Absent renders the honest
   * not-recorded note — the pipeline is never fabricated from reads.
   */
  readonly command?: MutationAcknowledgement | null;
  /**
   * The last mutation flow result, when the caller surfaces one on this
   * page: a typed failure renders the contextual support escape.
   */
  readonly lastResult?: MutationFlowResult;
}

function capabilityRowFor(
  sim: DeviceSimResource,
  capability: "esim_profile_install" | "esim_profile_remove" | "esim_profile_enable",
): EsimCapabilityRowResource | undefined {
  return sim.capabilities.find((row) => row.capability === capability);
}

function gateAllowed(
  sim: DeviceSimResource,
  capability: "esim_profile_install" | "esim_profile_remove" | "esim_profile_enable",
): boolean {
  return capabilityRowFor(sim, capability)?.gate.decision === "allow";
}

// --------------------------------------------------------------------------------
// The capability truth table + the closed guidance map
// --------------------------------------------------------------------------------

function capabilityTruthSection(sim: DeviceSimResource): HtmlFragment {
  return el(
    "section",
    { class: "panel", "data-esim-capabilities": "true" },
    fragment(
      el("h3", {}, text("What this device can do with eSIM profiles")),
      el(
        "p",
        { class: "muted" },
        text(
          "Evidence-based: RoamLink only offers an action when the platform's verified capability evidence allows it. The names are the closed capability vocabulary; the gate column is what admission would decide right now.",
        ),
      ),
      tableWrap(
        "The eSIM capability truth for this device",
        el(
          "table",
          { "data-esim-capability-rows": "true" },
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
          el(
            "tbody",
            {},
            ...sim.capabilities.map((row) =>
              el(
                "tr",
                { "data-esim-capability": row.capability, "data-esim-gate": row.gate.decision },
                el("td", {}, text(row.capability)),
                el(
                  "td",
                  {},
                  fragment(
                    stateBadge(row.status),
                    text(` ${ESIM_CAPABILITY_STATUS_LANGUAGE[row.status] ?? row.status}`),
                  ),
                ),
                el(
                  "td",
                  {},
                  row.evidenceClass === null
                    ? el("span", { class: "muted" }, text("none recorded"))
                    : text(row.evidenceClass),
                ),
                el("td", {}, freshnessBadge(row.freshness)),
                el(
                  "td",
                  { "data-esim-gate-reason": row.gate.reason ?? undefined },
                  text(
                    row.gate.decision === "allow"
                      ? ESIM_GATE_LANGUAGE.allow ?? "allow"
                      : `${ESIM_GATE_LANGUAGE[row.gate.decision] ?? row.gate.decision} (${row.gate.reason ?? "capability-unknown"})`,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * The closed guidance map: the static manual fallback (always true — the
 * device's own settings are always yours, exactly like the device page's
 * fallback panel) plus one guidance line per blocked capability, keyed by
 * the gate's closed reason vocabulary. Blocked actions are presented WITH
 * their guidance — never a disabled control with no explanation.
 */
function blockedGuidanceSection(sim: DeviceSimResource): HtmlFragment {
  const blocked = sim.capabilities.filter((row) => row.gate.decision !== "allow");
  return el(
    "section",
    {
      class: "panel",
      "data-esim-guidance": blocked.length > 0 ? "true" : "none",
      "data-esim-guidance-blocked-count": String(blocked.length),
    },
    fragment(
      el("h3", {}, text("When the platform cannot do it for you")),
      el(
        "ul",
        { class: "fallback-list" },
        ...MANUAL_FALLBACK_GUIDANCE.map((line) => el("li", {}, text(line))),
        ...blocked.map((row) =>
          el(
            "li",
            { "data-esim-guidance-capability": row.capability },
            fragment(
              el("strong", {}, text(row.capability)),
              text(" — "),
              text(esimManualGuidanceFor(row.gate.reason, row.capability)),
            ),
          ),
        ),
      ),
    ),
  );
}

// --------------------------------------------------------------------------------
// The install flow (activation-code entry where the platform requires it)
// --------------------------------------------------------------------------------

function installSection(sim: DeviceSimResource): HtmlFragment {
  const installRow = capabilityRowFor(sim, "esim_profile_install");
  const allowed = gateAllowed(sim, "esim_profile_install");
  return el(
    "section",
    { class: "panel", "data-esim-install": allowed ? "true" : "blocked" },
    fragment(
      el("h3", {}, text("Install a new profile")),
      allowed
        ? fragment(
            el(
              "form",
              {
                method: "post",
                action: "/flows/esim-install",
                "data-flow": "esim-install",
              },
              el("input", { type: "hidden", name: "deviceId", value: sim.deviceId }),
              ...(sim.installRequiresActivationCode
                ? [
                    el("label", { for: "esim-activation-code" }, text("Activation code")),
                    el("input", {
                      type: "text",
                      name: "activationCode",
                      id: "esim-activation-code",
                      required: true,
                      autocomplete: "off",
                    }),
                  ]
                : []),
              el("button", { type: "submit" }, text("Install profile")),
            ),
            el(
              "p",
              { class: "muted" },
              text(
                sim.installRequiresActivationCode
                  ? "The activation code comes from your carrier or provider — RoamLink passes it to the device and never stores it."
                  : "RoamLink sends the install request to the device directly.",
              ),
            ),
            el(
              "p",
              { class: "muted" },
              text(
                "Installing is a request: the profile appears in the list below once the device confirms it — a requested install is not an installed profile.",
              ),
            ),
          )
        : fragment(
            el(
              "p",
              {},
              text(
                `Installing a profile is not available on this device (${installRow?.gate.reason ?? "capability-unknown"}).`,
              ),
            ),
            el(
              "p",
              { class: "muted" },
              text(esimManualGuidanceFor(installRow?.gate.reason ?? null, "esim_profile_install")),
            ),
          ),
    ),
  );
}

// --------------------------------------------------------------------------------
// The profile inventory (state + evidence/freshness, never a naked status)
// --------------------------------------------------------------------------------

function profileActions(
  sim: DeviceSimResource,
  profile: EsimProfileResource,
): HtmlFragment {
  // While a change is outstanding, no new action is offered — the honest
  // busy state, not a mystery.
  if (profile.pending !== null) {
    return el(
      "p",
      { class: "muted" },
      text("Waiting for the device's confirmation — no new action until it settles."),
    );
  }
  const enableAllowed = gateAllowed(sim, "esim_profile_enable");
  const removeAllowed = gateAllowed(sim, "esim_profile_remove");
  const confirmed = profile.state === "enabled" || profile.state === "disabled";
  return fragment(
    confirmed && enableAllowed
      ? el(
          "form",
          {
            method: "post",
            action: "/flows/esim-enable",
            "data-flow": "esim-enable",
            "data-esim-desired": profile.state === "enabled" ? "disable" : "enable",
          },
          el("input", { type: "hidden", name: "deviceId", value: sim.deviceId }),
          el("input", { type: "hidden", name: "profileId", value: profile.profileId }),
          el("input", {
            type: "hidden",
            name: "enabled",
            value: profile.state === "enabled" ? "false" : "true",
          }),
          el(
            "button",
            { type: "submit" },
            text(profile.state === "enabled" ? "Disable this profile" : "Enable this profile"),
          ),
        )
      : confirmed
        ? el(
            "p",
            { class: "muted" },
            text(
              `Enabling or disabling is not available on this device — ${esimManualGuidanceFor(
                capabilityRowFor(sim, "esim_profile_enable")?.gate.reason ?? null,
                "esim_profile_enable",
              )}`,
            ),
          )
        : fragment(),
    removeAllowed
      ? el(
          "form",
          {
            method: "post",
            action: "/flows/esim-remove",
            "data-flow": "esim-remove",
          },
          el("input", { type: "hidden", name: "deviceId", value: sim.deviceId }),
          el("input", { type: "hidden", name: "profileId", value: profile.profileId }),
          el("button", { type: "submit" }, text("Remove this profile")),
        )
      : el(
          "p",
          { class: "muted" },
          text(
            `Removing is not available on this device — ${esimManualGuidanceFor(
              capabilityRowFor(sim, "esim_profile_remove")?.gate.reason ?? null,
              "esim_profile_remove",
            )}`,
          ),
        ),
  );
}

function profileCard(sim: DeviceSimResource, profile: EsimProfileResource): HtmlFragment {
  const confirmed = profile.state === "enabled" || profile.state === "disabled";
  return el(
    "li",
    {
      class: "goal-card",
      "data-esim-profile-id": profile.profileId,
      "data-esim-profile-state": profile.state,
    },
    fragment(
      el("h3", {}, text(profile.label)),
      el(
        "p",
        {},
        fragment(
          text("State: "),
          stateBadge(profile.state),
          text(` ${ESIM_PROFILE_STATE_LANGUAGE[profile.state] ?? profile.state}`),
        ),
      ),
      // Never a naked status: the platform evidence + freshness always ride
      // with the claimed state, or their honest absence is stated.
      confirmed
        ? el(
            "p",
            { class: "muted" },
            fragment(
              text("Platform evidence: "),
              text(profile.evidenceClass ?? "none recorded"),
              text(" · Freshness: "),
              freshnessBadge(profile.freshness),
              text(" · Installed "),
              instantView(profile.installedAt),
            ),
          )
        : el(
            "p",
            { class: "muted", "data-esim-unconfirmed": "true" },
            fragment(
              text("No platform confirmation yet — RoamLink recorded the request"),
              ...(profile.pending === null
                ? []
                : [
                    text(" "),
                    instantView(profile.pending.requestedAt),
                    text(` (command ${profile.pending.commandId})`),
                  ]),
              text(
                ". A requested change is not a completed change: the device confirms it, and only then does the profile claim a state.",
              ),
            ),
          ),
      profileActions(sim, profile),
    ),
  );
}

function profileInventorySection(sim: DeviceSimResource): HtmlFragment {
  return fragment(
    pageHeading(
      "Profiles on this device",
      "Each profile's state with the evidence behind it — platform-confirmed states carry their evidence class and freshness; requested changes carry the outstanding command and nothing more.",
    ),
    sim.profiles.length === 0
      ? el(
          "div",
          { class: "panel", "data-esim-profiles-empty": "true" },
          text(
            "No eSIM profiles are recorded for this device yet. When one is installed, it appears here with its evidence.",
          ),
        )
      : el(
          "ul",
          { class: "goal-list", "aria-label": "eSIM profiles on this device", "data-esim-profiles": "true" },
          ...sim.profiles.map((profile) => profileCard(sim, profile)),
        ),
  );
}

// --------------------------------------------------------------------------------
// The command pipeline + the failure escape
// --------------------------------------------------------------------------------

function commandPipelineSection(command: MutationAcknowledgement | null): HtmlFragment {
  if (command === null || command === undefined) {
    return el(
      "section",
      { class: "panel", "data-esim-command-pipeline": "absent" },
      fragment(
        el("h3", {}, text("Command pipeline")),
        el(
          "p",
          { class: "muted" },
          text(
            "The four-stage command record is not part of this read. Everything this page claims comes from the capability and profile reads above; Activity records what RoamLink has done.",
          ),
        ),
      ),
    );
  }
  return el(
    "section",
    { class: "panel", "data-esim-command-pipeline": "true", "data-command-id": command.commandId },
    fragment(
      el("h3", {}, text("Command pipeline")),
      el(
        "p",
        { class: "muted" },
        text(
          "The four stages stay separate on purpose — accepted is not executed, executed is not delivered, and delivered is not billable-final. A device command records RoamLink's own processing; the device's confirmation is the profile evidence above, never a pipeline stage.",
        ),
      ),
      mutationStages(command),
    ),
  );
}

function failureEscapeSection(
  device: DeviceResource,
  lastResult: MutationFlowResult | undefined,
): HtmlFragment {
  if (lastResult === undefined || lastResult.status !== "error") {
    return fragment();
  }
  return supportEscape({
    context: {
      subject:
        "An eSIM profile action on my device failed and I need help completing it.",
      refs: [{ kind: "device", id: device.deviceId }],
    },
  });
}

export function simProfilesPage(input: SimProfilesPageInput): HtmlFragment {
  const device = input.device;
  const sim = input.sim;
  // Degraded capability evidence (stale/unknown) carries the contextual
  // support escape (RL-103) alongside the closed guidance map.
  const degradedEvidence = sim.capabilities.some(
    (row) => row.freshness === null || row.freshness.freshnessState !== "FRESH",
  );
  return fragment(
    pageHeading(
      "SIM & Profiles",
      "The eSIM profiles on this device — what the platform reports it can do, what RoamLink has commanded, and what the device has actually confirmed. Every claimed state carries its evidence.",
    ),
    el(
      "p",
      {},
      el("a", { href: pagePath("device", { deviceId: device.deviceId }) }, text("Open this device")),
    ),
    el(
      "section",
      { "data-sim-profiles-page": "true", "data-device-id": device.deviceId },
      fragment(
        capabilityTruthSection(sim),
        blockedGuidanceSection(sim),
        installSection(sim),
        profileInventorySection(sim),
        commandPipelineSection(input.command ?? null),
        degradedEvidence
          ? supportEscape({
              context: {
                subject:
                  "My device's eSIM capability evidence is stale or missing and needs re-checking.",
                refs: [{ kind: "device", id: device.deviceId }],
              },
            })
          : fragment(),
        failureEscapeSection(device, input.lastResult),
      ),
    ),
  );
}
