import { describe, expect, it } from "vitest";
import { ConflictError } from "@roamlink/contracts";
import {
  FORBIDDEN_METRIC_LABEL_NAMES,
  MetricRegistry,
  createMetricsRecorder,
  isMetricName,
  parseMetricLabelName,
  parseMetricName,
} from "../src/index.js";

function registryWithCore(): MetricRegistry {
  const registry = new MetricRegistry();
  registry.register({
    name: "roamlink_edge_actions_total",
    kind: "counter",
    help: "Device actions gated and dispatched.",
    labelNames: ["capability", "outcome"],
  });
  registry.register({
    name: "roamlink_sync_outbox_depth",
    kind: "gauge",
    help: "Pending outbox records.",
    labelNames: ["device_class"],
  });
  registry.register({
    name: "roamlink_gate_evaluation_ms",
    kind: "histogram",
    help: "Capability gate evaluation duration.",
    labelNames: [],
  });
  return registry;
}

describe("metric name convention", () => {
  it("accepts roamlink_<component>_<name> and rejects everything else", () => {
    for (const good of [
      "roamlink_edge_actions_total",
      "roamlink_adcos_requests_duration_ms",
      "roamlink_sync_outbox_depth",
    ]) {
      expect(isMetricName(good)).toBe(true);
      expect(parseMetricName(good)).toBe(good);
    }
    for (const bad of [
      "edge_actions_total", // missing prefix
      "roamlink_actions", // single segment after prefix
      "RoamLink_Actions_Total", // case
      "roamlink_actions-total", // dash
      "roamlink_" + "x".repeat(200), // too long
      "",
      42,
    ]) {
      expect(isMetricName(bad)).toBe(false);
      expect(() => parseMetricName(bad)).toThrowError(/must match roamlink_/);
    }
  });

  it("label names validate shape only (secret-suggestive names are blocked at registration, not by shape)", () => {
    expect(parseMetricLabelName("capability")).toBe("capability");
    expect(parseMetricLabelName("device_class")).toBe("device_class");
    expect(() => parseMetricLabelName("DeviceClass")).toThrowError();
    expect(() => parseMetricLabelName("bad-label")).toThrowError();
    // the forbidden names are shape-valid (they are caught by register(), see below)
    for (const forbidden of FORBIDDEN_METRIC_LABEL_NAMES) {
      expect(() => parseMetricLabelName(forbidden)).not.toThrow();
    }
  });
});

describe("MetricRegistry", () => {
  it("registers definitions and rejects duplicates, kinds, help and labels", () => {
    const registry = new MetricRegistry();
    registry.register({
      name: "roamlink_test_metric_total",
      kind: "counter",
      help: "ok",
      labelNames: ["a"],
    });
    expect(registry.size).toBe(1);
    expect(registry.has("roamlink_test_metric_total")).toBe(true);

    expect(() =>
      registry.register({
        name: "roamlink_test_metric_total",
        kind: "counter",
        help: "dup",
        labelNames: [],
      }),
    ).toThrowError(ConflictError);
    expect(() =>
      registry.register({ name: "bad name", kind: "counter", help: "x", labelNames: [] }),
    ).toThrowError(/must match roamlink_/);
    expect(() =>
      registry.register({
        name: "roamlink_other_total",
        kind: "timer",
        help: "x",
        labelNames: [],
      }),
    ).toThrowError(/counter, gauge, histogram/);
    expect(() =>
      registry.register({ name: "roamlink_other_total", kind: "gauge", help: "", labelNames: [] }),
    ).toThrowError(/help/);
    expect(() =>
      registry.register({
        name: "roamlink_other_total",
        kind: "gauge",
        help: "x",
        labelNames: ["a", "a"],
      }),
    ).toThrowError(/unique/);
  });

  it("forbids secret-suggestive label names at registration (RL-LOCK-016)", () => {
    const registry = new MetricRegistry();
    expect(() =>
      registry.register({
        name: "roamlink_http_requests_total",
        kind: "counter",
        help: "x",
        labelNames: ["token"],
      }),
    ).toThrowError(/forbidden/);
    expect(() =>
      registry.register({
        name: "roamlink_http_requests_total",
        kind: "counter",
        help: "x",
        labelNames: ["path", "api_key"],
      }),
    ).toThrowError(/forbidden/);
  });
});

describe("createMetricsRecorder (label contract, fail-closed)", () => {
  it("records counter/gauge/histogram samples against registered definitions", () => {
    const recorder = createMetricsRecorder(registryWithCore());
    recorder.incrementCounter("roamlink_edge_actions_total", { capability: "wifi_control", outcome: "allow" });
    recorder.incrementCounter("roamlink_edge_actions_total", { capability: "wifi_control", outcome: "allow" }, 4);
    recorder.setGauge("roamlink_sync_outbox_depth", 12, { device_class: "phone" });
    recorder.observeHistogram("roamlink_gate_evaluation_ms", 3);

    const samples = recorder.samples();
    expect(samples).toHaveLength(4);
    expect(samples[0]).toMatchObject({
      kind: "counter",
      name: "roamlink_edge_actions_total",
      delta: 1,
    });
    expect(samples[1]).toMatchObject({ delta: 4 });
    expect(samples[2]).toMatchObject({ kind: "gauge", value: 12 });
    expect(samples[3]).toMatchObject({ kind: "histogram", value: 3 });
    recorder.clear();
    expect(recorder.samples()).toHaveLength(0);
  });

  it("fails closed on unregistered names and kind mismatches", () => {
    const recorder = createMetricsRecorder(registryWithCore());
    expect(() => recorder.incrementCounter("roamlink_not_registered_total")).toThrowError(
      /not registered/,
    );
    expect(() =>
      recorder.setGauge("roamlink_edge_actions_total", 1, { capability: "c", outcome: "o" }),
    ).toThrowError(/kind mismatch/);
    expect(() =>
      recorder.observeHistogram("roamlink_sync_outbox_depth", 1, { device_class: "phone" }),
    ).toThrowError(/kind mismatch/);
  });

  it("enforces the EXACT label set: missing and unknown labels are rejected", () => {
    const recorder = createMetricsRecorder(registryWithCore());
    expect(() =>
      recorder.incrementCounter("roamlink_edge_actions_total", { capability: "wifi_control" }),
    ).toThrowError(/missing required metric label 'outcome'/);
    expect(() =>
      recorder.incrementCounter("roamlink_edge_actions_total", {
        capability: "wifi_control",
        outcome: "allow",
        extra: "nope",
      }),
    ).toThrowError(/unknown metric label 'extra'/);
  });

  it("validates values: counters only increase; gauges/histograms must be finite", () => {
    const recorder = createMetricsRecorder(registryWithCore());
    expect(() =>
      recorder.incrementCounter("roamlink_edge_actions_total", { capability: "c", outcome: "o" }, 0),
    ).toThrowError(/integers >= 1/);
    expect(() =>
      recorder.incrementCounter("roamlink_edge_actions_total", { capability: "c", outcome: "o" }, -3),
    ).toThrowError(/integers >= 1/);
    expect(() =>
      recorder.incrementCounter("roamlink_edge_actions_total", { capability: "c", outcome: "o" }, 1.5),
    ).toThrowError(/integers >= 1/);
    expect(() => recorder.observeHistogram("roamlink_gate_evaluation_ms", Number.NaN)).toThrowError(
      /finite/,
    );
    expect(() =>
      recorder.setGauge("roamlink_sync_outbox_depth", 1, { device_class: "x".repeat(200) }),
    ).toThrowError(/at most 128 chars/);
  });
});
