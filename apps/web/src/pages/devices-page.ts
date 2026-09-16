/**
 * The devices page (RL-060): device list + enroll/update/retire command
 * surfaces. Pure function over parsed resources; all mutations go through
 * the app's flows (never this page).
 */
import {
  emptyState,
  freshnessBadge,
  instantView,
  stateBadge,
  el,
  fragment,
  text,
  type DeviceResource,
  type HtmlFragment,
} from "@roamlink/app-kit";

import { pageHeading } from "../app.js";

const PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "embedded",
  "other",
] as const;

export function devicesPage(input: { readonly devices: readonly DeviceResource[] }): HtmlFragment {
  return fragment(
    pageHeading("Devices", "Enrollment, platform metadata and observation freshness."),
    el(
      "table",
      { "data-devices": "true" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, text("Name")),
          el("th", {}, text("Platform")),
          el("th", {}, text("Status")),
          el("th", {}, text("Revision")),
          el("th", {}, text("Capability freshness")),
          el("th", {}, text("Context freshness")),
          el("th", {}, text("Updated")),
        ),
      ),
      el(
        "tbody",
        {},
        ...input.devices.map((device) =>
          el(
            "tr",
            { "data-device-id": device.deviceId },
            el("td", {}, text(device.name)),
            el("td", {}, text(device.platform)),
            el("td", {}, stateBadge(device.status)),
            el("td", {}, text(device.revision)),
            el("td", {}, freshnessBadge(device.capabilityFreshness)),
            el("td", {}, freshnessBadge(device.contextFreshness)),
            el("td", {}, instantView(device.updatedAt)),
          ),
        ),
      ),
    ),
    input.devices.length === 0 ? emptyState("devices") : fragment(),
    pageHeading("Enroll a device"),
    el(
      "form",
      { method: "post", action: "/flows/enroll-device", "data-flow": "enroll-device" },
      el("label", {}, text("Name ")),
      el("input", { type: "text", name: "name", required: true }),
      el("label", {}, text(" Platform ")),
      el(
        "select",
        { name: "platform" },
        ...PLATFORMS.map((platform) => el("option", { value: platform }, text(platform))),
      ),
      el("button", { type: "submit" }, text("Enroll device")),
    ),
    pageHeading("Update / retire a device"),
    el(
      "form",
      { method: "post", action: "/flows/update-device", "data-flow": "update-device" },
      el("label", {}, text("Device id ")),
      el("input", { type: "text", name: "deviceId", required: true }),
      el("label", {}, text(" New name ")),
      el("input", { type: "text", name: "name" }),
      el("button", { type: "submit" }, text("Update device")),
    ),
    el(
      "form",
      { method: "post", action: "/flows/retire-device", "data-flow": "retire-device" },
      el("label", {}, text("Device id ")),
      el("input", { type: "text", name: "deviceId", required: true }),
      el("button", { type: "submit" }, text("Retire device")),
    ),
    el(
      "p",
      { class: "muted" },
      text("Mutations carry request, correlation and idempotency ids plus your actor/tenant context; versioned updates command against the current revision (a lost race is reported as a conflict, never silently overwritten)."),
    ),
  );
}
