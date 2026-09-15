/**
 * Metrics contract (RL-040 platform scaffolding; RL-052 will build the SLO
 * instrumentation on top). NO VENDOR SDK.
 *
 * The contract covers counter/gauge/histogram NAMES + labels:
 *  - names follow `roamlink_<component>_<name>` snake_case and are validated
 *    (at least two segments after the prefix, bounded length);
 *  - label names are validated snake_case and checked against a forbidden
 *    list of secret-suggestive names (RL-LOCK-016);
 *  - a {@link MetricRegistry} pins each metric's kind and its EXACT closed
 *    label set; the recorder validates kind match and label-set equality at
 *    record time - unknown labels, missing labels and kind mismatches fail
 *    closed;
 *  - the provided recorder is an in-memory implementation for tests and
 *    local pipelines; production exporters are additive future work.
 */
import { ConflictError, ValidationError, type Branded } from "@roamlink/contracts";

export const METRIC_KINDS = ["counter", "gauge", "histogram"] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];

export type MetricName = Branded<"MetricName">;
export type MetricLabelName = Branded<"MetricLabelName">;

export const METRIC_NAME_PATTERN = /^roamlink_[a-z0-9]+(?:_[a-z0-9]+)+$/;
export const METRIC_LABEL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Label names that may never be registered (secret-suggestive, RL-LOCK-016). */
export const FORBIDDEN_METRIC_LABEL_NAMES = [
  "secret",
  "token",
  "password",
  "credential",
  "credentials",
  "authorization",
  "apikey",
  "api_key",
  "private_key",
  "privatekey",
  "access_key",
] as const;

const MAX_METRIC_NAME_LENGTH = 96;
const MAX_LABEL_VALUE_LENGTH = 128;
const MAX_LABELS_PER_METRIC = 12;

export function isMetricName(value: unknown): value is MetricName {
  return (
    typeof value === "string" &&
    value.length <= MAX_METRIC_NAME_LENGTH &&
    METRIC_NAME_PATTERN.test(value)
  );
}

export function parseMetricName(value: unknown): MetricName {
  if (!isMetricName(value)) {
    throw new ValidationError(
      "metric names must match roamlink_<component>_<name> snake_case with at least two segments after the prefix (e.g. roamlink_edge_actions_total), at most 96 chars",
      {
        reason: "METRIC_NAME_INVALID",
        details: [{ path: "MetricName", issue: "violates the naming convention" }],
      },
    );
  }
  return value;
}

export function isMetricLabelName(value: unknown): value is MetricLabelName {
  return typeof value === "string" && METRIC_LABEL_NAME_PATTERN.test(value);
}

export function parseMetricLabelName(value: unknown): MetricLabelName {
  if (!isMetricLabelName(value)) {
    throw new ValidationError(
      "metric label names must be snake_case labels matching /^[a-z][a-z0-9_]{0,63}$/",
      {
        reason: "METRIC_LABEL_INVALID",
        details: [{ path: "MetricLabelName", issue: "violates the naming convention" }],
      },
    );
  }
  return value;
}

function isForbiddenLabelName(value: string): boolean {
  return (FORBIDDEN_METRIC_LABEL_NAMES as readonly string[]).includes(value);
}

/** A registered metric definition: name + kind + help + EXACT closed label set. */
export interface MetricDefinition {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly help: string;
  readonly labelNames: readonly MetricLabelName[];
}

/** Input accepted by {@link MetricRegistry.register}. */
export interface MetricDefinitionInput {
  readonly name: string;
  readonly kind: string;
  readonly help: string;
  readonly labelNames: readonly string[];
}

function parseMetricKind(value: unknown): MetricKind {
  if (typeof value !== "string" || !(METRIC_KINDS as readonly string[]).includes(value)) {
    throw new ValidationError(
      "metric kind must be one of counter, gauge, histogram",
      {
        reason: "METRIC_KIND_INVALID",
        details: [{ path: "kind", issue: "outside the closed vocabulary" }],
      },
    );
  }
  return value as MetricKind;
}

/** Registry of metric definitions; the single place names/labels are pinned. */
export class MetricRegistry {
  #definitions = new Map<MetricName, MetricDefinition>();

  /** Validates and registers a definition; duplicate names conflict. */
  register(input: MetricDefinitionInput): MetricDefinition {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("MetricDefinition input must be an object", {
        reason: "METRIC_DEFINITION_INVALID",
        details: [{ path: "MetricDefinition", issue: "not an object" }],
      });
    }
    const name = parseMetricName(input.name);
    if (this.#definitions.has(name)) {
      throw new ConflictError(`a metric is already registered under this name`, {
        reason: "METRIC_ALREADY_REGISTERED",
        details: [{ path: "name", issue: "duplicate registration" }],
      });
    }
    const kind = parseMetricKind(input.kind);
    if (typeof input.help !== "string" || input.help.length === 0 || input.help.length > 256) {
      throw new ValidationError("metric help must be a non-empty string of at most 256 chars", {
        reason: "METRIC_DEFINITION_INVALID",
        details: [{ path: "help", issue: "out of bounds" }],
      });
    }
    if (
      input.labelNames === null ||
      typeof input.labelNames !== "object" ||
      !Array.isArray(input.labelNames) ||
      input.labelNames.length > MAX_LABELS_PER_METRIC
    ) {
      throw new ValidationError(`metrics declare at most ${MAX_LABELS_PER_METRIC} labels`, {
        reason: "METRIC_DEFINITION_INVALID",
        details: [{ path: "labelNames", issue: "not a bounded label list" }],
      });
    }
    const seen = new Set<string>();
    const labelNames: MetricLabelName[] = [];
    for (const raw of input.labelNames) {
      const labelName = parseMetricLabelName(raw);
      if (isForbiddenLabelName(labelName)) {
        throw new ValidationError(
          "secret-suggestive label names are forbidden on metrics (RL-LOCK-016)",
          {
            reason: "METRIC_LABEL_FORBIDDEN",
            details: [{ path: `labelNames`, issue: "a forbidden label name was supplied" }],
          },
        );
      }
      if (seen.has(labelName)) {
        throw new ValidationError("metric label names must be unique", {
          reason: "METRIC_DEFINITION_INVALID",
          details: [{ path: "labelNames", issue: "duplicate label name" }],
        });
      }
      seen.add(labelName);
      labelNames.push(labelName);
    }
    const definition: MetricDefinition = Object.freeze({
      name,
      kind,
      help: input.help,
      labelNames: Object.freeze(labelNames),
    });
    this.#definitions.set(name, definition);
    return definition;
  }

  has(name: string): boolean {
    return this.#definitions.has(name as MetricName);
  }

  get(name: string): MetricDefinition | undefined {
    return this.#definitions.get(name as MetricName);
  }

  definitions(): readonly MetricDefinition[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  get size(): number {
    return this.#definitions.size;
  }
}

export type MetricLabelValue = string | number | boolean;

export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

/** One recorded sample. */
export type MetricSample =
  | {
      readonly kind: "counter";
      readonly name: MetricName;
      readonly labels: Readonly<Record<MetricLabelName, MetricLabelValue>>;
      readonly delta: number;
    }
  | {
      readonly kind: "gauge";
      readonly name: MetricName;
      readonly labels: Readonly<Record<MetricLabelName, MetricLabelValue>>;
      readonly value: number;
    }
  | {
      readonly kind: "histogram";
      readonly name: MetricName;
      readonly labels: Readonly<Record<MetricLabelName, MetricLabelValue>>;
      readonly value: number;
    };

/** The recorder port (no vendor SDK). */
export interface MetricsRecorder {
  incrementCounter(name: string, labels?: MetricLabels, delta?: number): void;
  setGauge(name: string, value: number, labels?: MetricLabels): void;
  observeHistogram(name: string, value: number, labels?: MetricLabels): void;
}

export type InMemoryMetrics = MetricsRecorder & {
  samples(): readonly MetricSample[];
  clear(): void;
};

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * In-memory metrics recorder validating against the registry: unregistered
 * names, kind mismatches, unknown/missing labels and out-of-bound values
 * fail closed. Counters only increase (integer deltas >= 1); gauge and
 * histogram values must be finite.
 */
export function createMetricsRecorder(registry: MetricRegistry): InMemoryMetrics {
  const samples: MetricSample[] = [];

  const resolve = (name: string, kind: MetricKind, labels: MetricLabels | undefined) => {
    if (!registry.has(name)) {
      throw new ValidationError("metric is not registered (register the definition first)", {
        reason: "METRIC_UNKNOWN",
        details: [{ path: "name", issue: "no definition registered" }],
      });
    }
    const definition = registry.get(name);
    if (definition === undefined) {
      throw new ValidationError("metric is not registered", {
        reason: "METRIC_UNKNOWN",
        details: [{ path: "name", issue: "no definition registered" }],
      });
    }
    if (definition.kind !== kind) {
      throw new ValidationError(
        `metric kind mismatch (registered as ${definition.kind}, recorded as ${kind})`,
        {
          reason: "METRIC_KIND_MISMATCH",
          details: [{ path: "name", issue: "kind mismatch" }],
        },
      );
    }
    const provided = labels ?? {};
    const expected = definition.labelNames;
    const resolved: Record<string, MetricLabelValue> = {};
    for (const labelName of expected) {
      const value = provided[labelName];
      if (value === undefined) {
        throw new ValidationError(
          `missing required metric label '${labelName}'`,
          {
            reason: "METRIC_LABEL_MISSING",
            details: [{ path: "labels", issue: `label '${labelName}' is required` }],
          },
        );
      }
      resolved[labelName] = value;
    }
    for (const key of Object.keys(provided)) {
      if (!(expected as readonly string[]).includes(key)) {
        throw new ValidationError(
          `unknown metric label '${key}' (not part of the registered label set)`,
          {
            reason: "METRIC_LABEL_UNKNOWN",
            details: [{ path: "labels", issue: `label '${key}' is not registered` }],
          },
        );
      }
    }
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value === "string") {
        if (value.length > MAX_LABEL_VALUE_LENGTH || hasControlCharacter(value)) {
          throw new ValidationError(
            `metric label '${key}' values must be at most ${MAX_LABEL_VALUE_LENGTH} chars and control-character free (never secrets - RL-LOCK-016)`,
            {
              reason: "METRIC_LABEL_VALUE_INVALID",
              details: [{ path: `labels.${key}`, issue: "value out of bounds" }],
            },
          );
        }
      } else if (typeof value === "number" && !Number.isFinite(value)) {
        throw new ValidationError(`metric label '${key}' numeric values must be finite`, {
          reason: "METRIC_LABEL_VALUE_INVALID",
          details: [{ path: `labels.${key}`, issue: "non-finite number" }],
        });
      }
    }
    return {
      name: definition.name,
      labels: Object.freeze(resolved) as Readonly<Record<MetricLabelName, MetricLabelValue>>,
    };
  };

  return {
    incrementCounter: (name, labels, delta = 1) => {
      const resolved = resolve(name, "counter", labels);
      if (typeof delta !== "number" || !Number.isInteger(delta) || delta < 1) {
        throw new ValidationError("counter deltas must be integers >= 1 (counters only increase)", {
          reason: "METRIC_VALUE_INVALID",
          details: [{ path: "delta", issue: "not a positive integer" }],
        });
      }
      samples.push(Object.freeze({ kind: "counter", ...resolved, delta }));
    },
    setGauge: (name, value, labels) => {
      const resolved = resolve(name, "gauge", labels);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ValidationError("gauge values must be finite numbers", {
          reason: "METRIC_VALUE_INVALID",
          details: [{ path: "value", issue: "not a finite number" }],
        });
      }
      samples.push(Object.freeze({ kind: "gauge", ...resolved, value }));
    },
    observeHistogram: (name, value, labels) => {
      const resolved = resolve(name, "histogram", labels);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ValidationError("histogram observations must be finite numbers", {
          reason: "METRIC_VALUE_INVALID",
          details: [{ path: "value", issue: "not a finite number" }],
        });
      }
      samples.push(Object.freeze({ kind: "histogram", ...resolved, value }));
    },
    samples: () => Object.freeze([...samples]),
    clear: () => {
      samples.length = 0;
    },
  };
}
