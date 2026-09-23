/**
 * The Devices pages (RL-087, spec/ux-architecture.md §9): the device
 * registry as the customer understands it — what the device is, what it can
 * do, and what connectivity it currently has — with honest unknown states
 * wherever the projection carries no data.
 *
 * Capability truth is evidence-based (RL-LOCK-011): the read model carries
 * the FRESHNESS of capability/context snapshots, not the capability facts,
 * so the capability card states only what the projection asserts and
 * presents not-yet-verified abilities as unknown — never an assumed
 * capability. Platform limitations become guidance: when RoamLink cannot
 * act on a device, the page explains the limitation and presents the
 * manual fallback instead of failing silently.
 *
 * The list page keeps the enroll/update/retire flows (field-compatible:
 * name/platform/deviceId); the detail page carries the device's own
 * capability card, its current connectivity observations (from the
 * authoritative read), its goals, its recent actions, and the manual
 * fallback guidance. Pure functions over parsed read models.
 */
import {
  freshnessBadge,
  instantView,
  stateBadge,
  disclosureSection,
  el,
  fragment,
  text,
  type ConnectivityOverviewResource,
  type DeviceResource,
  type ExperienceIntentResource,
  type HtmlFragment,
  type NotificationResource,
} from "@roamlink/app-kit";

import { pagePath } from "../routes.js";
import { pageHeading } from "../app.js";
import {
  AUTOMATION_LEVEL_LANGUAGE,
  DEVICE_CAPABILITY_LANGUAGE,
  DEVICE_CAPABILITY_UNKNOWN,
  DEVICE_PLATFORM_LANGUAGE,
  DEVICE_STATUS_LANGUAGE,
  MANUAL_FALLBACK_GUIDANCE,
} from "./language.js";
import { supportEscape } from "./support-context.js";

const PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "embedded",
  "other",
] as const;

/** Maps a freshness snapshot to the honest device capability statement. */
export function deviceCapabilityStatement(
  capabilityFreshness: DeviceResource["capabilityFreshness"],
): { readonly label: string; readonly detail: string; readonly state: string } {
  const state = capabilityFreshness?.freshnessState ?? "UNKNOWN";
  const language = DEVICE_CAPABILITY_LANGUAGE[state] ?? DEVICE_CAPABILITY_UNKNOWN;
  return { label: language.label, detail: language.detail, state };
}

// --------------------------------------------------------------------------------
// The list page
// --------------------------------------------------------------------------------

function deviceCard(
  device: DeviceResource,
  connectivity: ConnectivityOverviewResource,
): HtmlFragment {
  const observation = connectivity.deviceObservations.find(
    (o) => o.deviceId === device.deviceId,
  );
  const capability = deviceCapabilityStatement(device.capabilityFreshness);
  return el(
    "li",
    {
      class: "goal-card",
      "data-device-id": device.deviceId,
      "data-device-status": device.status,
    },
    fragment(
      el(
        "h3",
        {},
        el("a", { href: pagePath("device", { deviceId: device.deviceId }) }, text(device.name)),
      ),
      el(
        "p",
        { class: "muted" },
        fragment(
          text(`${DEVICE_PLATFORM_LANGUAGE[device.platform] ?? device.platform} · `),
          stateBadge(device.status),
          text(` ${DEVICE_STATUS_LANGUAGE[device.status] ?? device.status}`),
        ),
      ),
      el(
        "p",
        {},
        fragment(text("What it can do: "), el("strong", {}, text(capability.label))),
      ),
      observation === undefined
        ? el(
            "p",
            { class: "muted" },
            text("Current connectivity: no observations recorded for this device yet."),
          )
        : el(
            "p",
            { class: "muted" },
            fragment(
              text("Latest observation "),
              instantView(observation.lastObservedAt),
              text(" — capability "),
              freshnessBadge(observation.capabilityFreshness),
              text(", context "),
              freshnessBadge(observation.contextFreshness),
            ),
          ),
      el(
        "p",
        {},
        el("a", { href: pagePath("device", { deviceId: device.deviceId }) }, text("Open this device")),
      ),
    ),
  );
}

export function devicesPage(input: {
  readonly devices: readonly DeviceResource[];
  readonly connectivity: ConnectivityOverviewResource;
}): HtmlFragment {
  return fragment(
    pageHeading(
      "Devices",
      "The devices RoamLink helps on — what each one is, what it can do, and what it is seeing right now.",
    ),
    input.devices.length === 0
      ? el(
          "div",
          { class: "panel", "data-devices-empty": "true" },
          fragment(
            el("p", {}, text("No devices yet. RoamLink works on your goals through your devices, so add one to begin.")),
            el("p", {}, el("a", { href: pagePath("onboarding") }, text("Add your first device"))),
          ),
        )
      : el(
          "ul",
          { class: "goal-list", "data-devices": "true", "aria-label": "Your devices" },
          ...input.devices.map((device) => deviceCard(device, input.connectivity)),
        ),
    pageHeading("Add a device"),
    el(
      "form",
      { method: "post", action: "/flows/enroll-device", "data-flow": "enroll-device" },
      el("label", { for: "enroll-name" }, text("Name")),
      el("input", { type: "text", name: "name", id: "enroll-name", required: true }),
      el("label", { for: "enroll-platform" }, text("Kind of device")),
      el(
        "select",
        { name: "platform", id: "enroll-platform" },
        ...PLATFORMS.map((platform) =>
          el(
            "option",
            { value: platform },
            text(DEVICE_PLATFORM_LANGUAGE[platform] ?? platform),
          ),
        ),
      ),
      el("button", { type: "submit" }, text("Add device")),
    ),
    el(
      "p",
      { class: "muted" },
      text("RoamLink never needs your device password or accounts. Every change commands against the device's current revision; a conflicting change is reported, never overwritten."),
    ),
  );
}

// --------------------------------------------------------------------------------
// The device detail page
// --------------------------------------------------------------------------------

function capabilityCard(device: DeviceResource): HtmlFragment {
  const capability = deviceCapabilityStatement(device.capabilityFreshness);
  const automationLevels = ["automatic", "confirmation", "manual", "unavailable", "unknown"] as const;
  // Unverified or expired capability verification is a degraded state
  // (RL-103: unsupported/unknown capability carries the support escape with
  // the device reference).
  const degradedCapability = capability.state !== "FRESH";
  return el(
    "section",
    {
      class: "panel",
      "data-device-capability": "true",
      "data-capability-state": capability.state,
    },
    fragment(
      el("h3", {}, text("What this device can do")),
      el(
        "p",
        {},
        fragment(
          text(capability.label),
          text(" — "),
          el(
            "span",
            { class: "muted" },
            text(capability.detail),
          ),
        ),
      ),
      el(
        "p",
        { class: "muted" },
        fragment(
          text("Capability snapshot: "),
          freshnessBadge(device.capabilityFreshness),
          text(" · Context snapshot: "),
          freshnessBadge(device.contextFreshness),
        ),
      ),
      disclosureSection({
        layer: "evidence",
        summary: "Capability evidence",
        intro:
          "What RoamLink knows about this device's abilities, and how fresh that verification is. Absence of verification is stated, never bridged with an assumption.",
        body: el(
          "dl",
          { class: "fact-list", "data-capability-evidence": "true" },
          el(
            "div",
            { class: "fact-row" },
            el("dt", {}, text("Capability verification")),
            el(
              "dd",
              {},
              fragment(
                freshnessBadge(device.capabilityFreshness),
                device.capabilityFreshness === null
                  ? text(" (no observation recorded)")
                  : text(
                      ` — observed ${device.capabilityFreshness.observedAt ?? "never"}, received ${device.capabilityFreshness.receivedAt ?? "never"}`,
                    ),
              ),
            ),
          ),
          el(
            "div",
            { class: "fact-row" },
            el("dt", {}, text("Context snapshot")),
            el("dd", {}, freshnessBadge(device.contextFreshness)),
          ),
        ),
      }),
      disclosureSection({
        layer: "technical",
        summary: "Automation levels explained",
        intro:
          "The five automation levels RoamLink can hold for a device. You never need this section to understand your device.",
        body: el(
          "dl",
          { class: "fact-list", "data-automation-key": "true" },
          ...automationLevels.map((level) =>
            el(
              "div",
              { class: "fact-row" },
              el("dt", {}, text(level)),
              el("dd", {}, text(AUTOMATION_LEVEL_LANGUAGE[level])),
            ),
          ),
        ),
      }),
      el(
        "p",
        { class: "muted" },
        text("Which levels this device supports is established by verification, never assumed — anything unverified is treated as unknown."),
      ),
      degradedCapability
        ? supportEscape({
            context: {
              subject:
                capability.state === "STALE"
                  ? `My device ${device.name} needs its capability verification re-checked.`
                  : `RoamLink has not verified what my device ${device.name} can do yet.`,
              refs: [{ kind: "device", id: device.deviceId }],
            },
          })
        : fragment(),
    ),
  );
}

function deviceObservationSection(
  device: DeviceResource,
  connectivity: ConnectivityOverviewResource,
): HtmlFragment {
  const observation = connectivity.deviceObservations.find(
    (o) => o.deviceId === device.deviceId,
  );
  return el(
    "section",
    { "data-device-connectivity": "true" },
    fragment(
      pageHeading("What connectivity it has now", "From the authoritative connectivity read — observations are inputs, never merged into the connectivity facts."),
      observation === undefined
        ? el(
            "p",
            { class: "muted", "data-device-observation-empty": "true" },
            text("No connectivity observations recorded for this device yet. Once it reports in, its snapshots and freshness appear here."),
          )
        : el(
            "dl",
            { class: "fact-list", "data-device-observation": "true" },
            el(
              "div",
              { class: "fact-row" },
              el("dt", {}, text("Capability snapshot")),
              el("dd", {}, freshnessBadge(observation.capabilityFreshness)),
            ),
            el(
              "div",
              { class: "fact-row" },
              el("dt", {}, text("Context snapshot")),
              el("dd", {}, freshnessBadge(observation.contextFreshness)),
            ),
            el(
              "div",
              { class: "fact-row" },
              el("dt", {}, text("Last observed")),
              el("dd", {}, instantView(observation.lastObservedAt)),
            ),
          ),
      el("p", {}, el("a", { href: pagePath("connectivity") }, text("See the full connectivity journey"))),
    ),
  );
}

function deviceGoalsSection(
  device: DeviceResource,
  intents: readonly ExperienceIntentResource[],
): HtmlFragment {
  const deviceIntents = intents.filter((intent) => intent.deviceId === device.deviceId);
  return el(
    "section",
    { "data-device-goals": "true" },
    fragment(
      pageHeading("Goals for this device"),
      deviceIntents.length === 0
        ? el(
            "p",
            { class: "muted", "data-device-goals-empty": "true" },
            text("No goal involves this device yet. A goal tells RoamLink what a good connection looks like for this device."),
          )
        : el(
            "ul",
            { class: "goal-list", "aria-label": "Goals for this device" },
            ...deviceIntents.map((intent) =>
              el(
                "li",
                { class: "goal-card", "data-goal-id": intent.intentId },
                fragment(
                  el(
                    "p",
                    {},
                    fragment(
                      text(
                        intent.currentVersion === null
                          ? "Goal (not described yet)"
                          : intent.currentVersion.rationale,
                      ),
                    ),
                  ),
                  el(
                    "p",
                    { class: "muted" },
                    fragment(
                      text("Status: "),
                      stateBadge(intent.status),
                    ),
                  ),
                  el(
                    "p",
                    {},
                    el("a", { href: pagePath("intent", { intentId: intent.intentId }) }, text("Open this goal")),
                  ),
                ),
              ),
            ),
          ),
      // PA-004 (RL-114-F3): the journey trailing link joins the floored
      // `.journey-action a` family (the 44px touch-target floor).
      el("p", { class: "journey-action" }, el("a", { href: pagePath("intents") }, text("Manage goals"))),
    ),
  );
}

function deviceActionsSection(
  device: DeviceResource,
  notifications: readonly NotificationResource[],
): HtmlFragment {
  const deviceNotifications = notifications.filter((notification) =>
    notification.related.some((ref) => ref.kind === "device" && ref.id === device.deviceId),
  );
  return el(
    "section",
    { "data-device-actions": "true" },
    fragment(
      pageHeading("Recent actions on this device"),
      deviceNotifications.length === 0
        ? el(
            "p",
            { class: "muted", "data-device-actions-empty": "true" },
            text("No device-specific actions recorded yet. Everything RoamLink does for this device appears here and in Activity."),
          )
        : el(
            "ul",
            { class: "activity-list", "aria-label": "Recent actions on this device" },
            ...deviceNotifications.slice(0, 5).map((notification) =>
              el(
                "li",
                { class: "activity-item", "data-notification-id": notification.notificationId },
                fragment(
                  el("p", {}, fragment(el("strong", {}, text(notification.title)))),
                  el("p", { class: "muted" }, text(notification.body)),
                ),
              ),
            ),
          ),
      el("p", {}, el("a", { href: pagePath("activity") }, text("Open Activity"))),
    ),
  );
}

function deviceManagementForms(device: DeviceResource): HtmlFragment {
  return el(
    "section",
    { "data-device-manage": "true" },
    fragment(
      pageHeading("Manage this device"),
      el(
        "form",
        { method: "post", action: "/flows/update-device", "data-flow": "update-device" },
        el("input", { type: "hidden", name: "deviceId", value: device.deviceId }),
        el("label", { for: "device-new-name" }, text("Rename")),
        el("input", {
          type: "text",
          name: "name",
          id: "device-new-name",
          value: device.name,
          required: true,
        }),
        el("button", { type: "submit" }, text("Save name")),
      ),
      el(
        "form",
        { method: "post", action: "/flows/retire-device", "data-flow": "retire-device" },
        el("input", { type: "hidden", name: "deviceId", value: device.deviceId }),
        el("button", { type: "submit" }, text("Retire this device")),
      ),
      el(
        "p",
        { class: "muted" },
        text("Retiring stops RoamLink from managing this device. It is reported honestly if another change conflicts."),
      ),
    ),
  );
}

function deviceSimSection(device: DeviceResource): HtmlFragment {
  return el(
    "section",
    { "data-device-sim": "true" },
    fragment(
      pageHeading(
        "SIM & Profiles",
        "The eSIM profiles on this device — installs, removals and enablement, gated by what the platform actually allows.",
      ),
      el(
        "p",
        {},
        el(
          "a",
          { href: pagePath("deviceSim", { deviceId: device.deviceId }) },
          text("Manage SIM & profiles"),
        ),
      ),
    ),
  );
}

export function deviceDetailPage(input: {
  readonly device: DeviceResource;
  readonly connectivity: ConnectivityOverviewResource;
  readonly notifications: readonly NotificationResource[];
  readonly intents: readonly ExperienceIntentResource[];
}): HtmlFragment {
  const device = input.device;
  return fragment(
    pageHeading(
      device.name,
      `${DEVICE_PLATFORM_LANGUAGE[device.platform] ?? device.platform} · ${DEVICE_STATUS_LANGUAGE[device.status] ?? device.status}`,
    ),
    capabilityCard(device),
    deviceSimSection(device),
    deviceObservationSection(device, input.connectivity),
    deviceGoalsSection(device, input.intents),
    deviceActionsSection(device, input.notifications),
    el(
      "section",
      { class: "panel", "data-manual-fallback": "true" },
      fragment(
        el("h3", {}, text("When RoamLink cannot do it for you")),
        el(
          "ul",
          { class: "fallback-list" },
          ...MANUAL_FALLBACK_GUIDANCE.map((line) => el("li", {}, text(line))),
        ),
      ),
    ),
    deviceManagementForms(device),
  );
}
