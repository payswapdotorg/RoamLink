/**
 * RL-012 ExperienceIntentCompiler tests — all eight §4 stages, digest
 * stability, traceability (intent id + version preservation), determinism
 * and the pinned structural compatibility with the integration-side intent
 * command input (the field list the RL-031 adapter accepts).
 */
import { describe, expect, it } from "vitest";
import { ValidationError, canonicalJsonDigest, parseUtcInstant } from "@roamlink/contracts";
import { ExperienceIntentCompiler } from "../src/index.js";
import { compileExperienceIntent } from "../src/index.js";
import {
  INTENT_DIMENSIONS,
  CONNECTIVITY_INTENT_COMMAND_FIELDS,
} from "../src/index.js";
import { compileOptionsFixture, intentVersionPair, payloadFixture } from "./helpers.js";

const compiler = new ExperienceIntentCompiler();

// ---------------------------------------------------------------------------
// Stage 1 — schema validation
// ---------------------------------------------------------------------------

describe("RL-012 stage 1: schema validation", () => {
  it("compiles a valid active intent + current version", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(result.model.source.intentId).toBe(intent.intentId);
    expect(result.model.source.versionNumber).toBe(1);
  });

  it("compiles a valid draft intent (draft and active are both compilable)", () => {
    const { intent, version } = intentVersionPair({ status: "draft" });
    expect(() => compiler.compile(intent, version, compileOptionsFixture())).not.toThrow();
  });

  it("rejects a version record from a different tenant", () => {
    const { intent, version } = intentVersionPair();
    const foreign = {
      ...version,
      tenantId: "usr:00000000-0000-4000-8000-0000000000ff",
    } as typeof version;
    expect(() => compiler.compile(intent, foreign, compileOptionsFixture())).toThrow(ValidationError);
  });

  it("rejects a version record belonging to a different intent", () => {
    const { intent, version } = intentVersionPair();
    const foreign = {
      ...version,
      intentId: "00000000-0000-4000-8000-0000000000ee",
    } as typeof version;
    expect(() => compiler.compile(intent, foreign, compileOptionsFixture())).toThrow(ValidationError);
  });

  it("rejects compiling a stale (non-current) version", () => {
    const { intent, version } = intentVersionPair();
    const stale = {
      ...version,
      versionNumber: 2,
      supersedes: version.intentVersionId,
    } as typeof version;
    expect(() => compiler.compile(intent, stale, compileOptionsFixture())).toThrow(ValidationError);
  });

  for (const status of ["superseded", "archived", "canceled"] as const) {
    it(`rejects compiling a ${status} intent (frozen/terminal)`, () => {
      const { intent, version } = intentVersionPair({ status });
      expect(() => compiler.compile(intent, version, compileOptionsFixture())).toThrow(
        ValidationError,
      );
    });
  }

  it("rejects a missing compile instant (the compiler never reads a clock)", () => {
    const { intent, version } = intentVersionPair();
    const broken = {
      commandId: compileOptionsFixture().commandId,
    } as Parameters<typeof compiler.compile>[2];
    expect(() => compiler.compile(intent, version, broken)).toThrow(ValidationError);
  });

  it("rejects a non-UUID command id", () => {
    const { intent, version } = intentVersionPair();
    expect(() =>
      compiler.compile(intent, version, compileOptionsFixture({ commandId: "not-a-uuid" })),
    ).toThrow(ValidationError);
  });

  it("rejects a malformed intent record (re-validation through the domain constructor)", () => {
    const { version } = intentVersionPair();
    const broken = { bogus: true } as never;
    expect(() => compiler.compile(broken, version, compileOptionsFixture())).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — policy normalization (contradiction resolution)
// ---------------------------------------------------------------------------

describe("RL-012 stage 2: policy normalization", () => {
  it("drops a preferred access class that a hard constraint forbids, and records the decision", () => {
    const { intent, version } = intentVersionPair({
      payload: payloadFixture({
        preferences: {
          reliability: "high",
          latency: "interactive",
          costSensitivity: "medium",
          privacySensitivity: "low",
          preferredAccessClasses: ["open_wifi", "trusted_wifi"],
        },
        hardConstraints: {
          requireEncryptedTransport: true,
          forbidRoaming: false,
          forbidOpenWifi: true,
        },
      }),
    });
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const tech = result.model.requirements.filter((r) => r.dimension === "technology");
    const preferred = tech.filter((r) => r.classification === "soft");
    expect(preferred).toHaveLength(1);
    expect(preferred[0]?.statement).toEqual({ preferredAccessClass: "trusted_wifi", rank: 1 });
    const drops = result.model.policyDecisions.filter(
      (d) => d.kind === "dropped-contradictory-preference",
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual({
      kind: "dropped-contradictory-preference",
      accessClass: "open_wifi",
      because: "forbidOpenWifi",
    });
  });

  it("forbidRoaming drops the roaming_cellular preference and re-ranks the survivors", () => {
    const { intent, version } = intentVersionPair({
      payload: payloadFixture({
        preferences: {
          reliability: "standard",
          latency: "insensitive",
          costSensitivity: "low",
          privacySensitivity: "medium",
          preferredAccessClasses: ["trusted_wifi", "roaming_cellular", "wired"],
        },
        hardConstraints: {
          requireEncryptedTransport: false,
          forbidRoaming: true,
          forbidOpenWifi: false,
        },
      }),
    });
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const preferred = result.model.requirements.filter(
      (r) => r.dimension === "technology" && r.classification === "soft",
    );
    expect(preferred.map((r) => r.statement)).toEqual([
      { preferredAccessClass: "trusted_wifi", rank: 1 },
      { preferredAccessClass: "wired", rank: 2 },
    ]);
  });

  it("records preference-translated decisions for the mapped dimensions", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const translated = result.model.policyDecisions.filter(
      (d) => d.kind === "preference-translated",
    );
    const sources = translated.map((d) => (d as { source: string }).source).sort();
    expect(sources).toEqual([
      "preferences.costSensitivity",
      "preferences.latency",
      "preferences.privacySensitivity",
      "preferences.reliability",
      "usageProfile",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — hard/soft constraint classification (truth table)
// ---------------------------------------------------------------------------

describe("RL-012 stage 3: hard/soft constraint classification truth table", () => {
  const BOOLS = [false, true] as const;
  for (const requireEncryptedTransport of BOOLS) {
    for (const forbidRoaming of BOOLS) {
      for (const forbidOpenWifi of BOOLS) {
        const labels = [requireEncryptedTransport, forbidRoaming, forbidOpenWifi]
          .map((b) => (b ? "1" : "0"))
          .join("");
        void labels;
        const expectedHard = [requireEncryptedTransport, forbidRoaming, forbidOpenWifi].filter(
          Boolean,
        ).length;

        it(`classify requireEncryptedTransport=${requireEncryptedTransport} forbidRoaming=${forbidRoaming} forbidOpenWifi=${forbidOpenWifi} (mask ${labels})`, () => {
          const { intent, version } = intentVersionPair({
            payload: payloadFixture({
              preferences: {
                reliability: "high",
                latency: "interactive",
                costSensitivity: "medium",
                privacySensitivity: "high",
                preferredAccessClasses: ["trusted_wifi"],
              },
              hardConstraints: { requireEncryptedTransport, forbidRoaming, forbidOpenWifi },
            }),
          });
          const result = compiler.compile(intent, version, compileOptionsFixture());

          expect(result.model.hardRequirements).toHaveLength(expectedHard);
          expect(result.model.softRequirements).toHaveLength(6);

          const hard = result.model.hardRequirements;
          const hasEncryption = hard.some(
            (r) =>
              r.dimension === "privacy" &&
              JSON.stringify(r.statement) === JSON.stringify({ transportEncryption: "required" }),
          );
          const hasRoamingBan = hard.some(
            (r) =>
              r.dimension === "technology" &&
              JSON.stringify(r.statement) ===
                JSON.stringify({ forbiddenAccessClass: "roaming_cellular" }),
          );
          const hasOpenWifiBan = hard.some(
            (r) =>
              r.dimension === "technology" &&
              JSON.stringify(r.statement) === JSON.stringify({ forbiddenAccessClass: "open_wifi" }),
          );
          expect(hasEncryption).toBe(requireEncryptedTransport);
          expect(hasRoamingBan).toBe(forbidRoaming);
          expect(hasOpenWifiBan).toBe(forbidOpenWifi);

          // every statement is classified; hard and soft partition the set
          expect(result.model.requirements).toHaveLength(expectedHard + 6);
          for (const r of result.model.requirements) {
            expect(["hard", "soft"]).toContain(r.classification);
          }
        });
      }
    }
  }

  it("hard requirements sort before soft within the same dimension", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const privacy = result.model.requirements.filter((r) => r.dimension === "privacy");
    expect(privacy[0]?.classification).toBe("hard");
    expect(privacy[1]?.classification).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — privacy/service constraint mapping
// ---------------------------------------------------------------------------

describe("RL-012 stage 4: privacy/service constraint mapping", () => {
  it("maps privacy sensitivity into a soft privacy statement", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const privacySoft = result.model.requirements.find(
      (r) => r.dimension === "privacy" && r.classification === "soft",
    );
    expect(privacySoft?.statement).toEqual({ sensitivity: "high" });
  });

  it("maps the service family: reliability level + latency sensitivity", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const reliability = result.model.requirements.find((r) => r.dimension === "reliability");
    const latency = result.model.requirements.find((r) => r.dimension === "latency");
    expect(reliability?.statement).toEqual({ level: "high" });
    expect(latency?.statement).toEqual({ sensitivity: "interactive" });
    expect(reliability?.classification).toBe("soft");
    expect(latency?.classification).toBe("soft");
  });

  it("maps the encrypted-transport hard constraint into the privacy dimension", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const encryption = result.model.requirements.find(
      (r) => r.dimension === "privacy" && r.classification === "hard",
    );
    expect(encryption?.statement).toEqual({ transportEncryption: "required" });
  });

  it("maps the usage profile into a soft usage statement", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const usage = result.model.requirements.find((r) => r.dimension === "usage");
    expect(usage?.statement).toEqual({ profile: "travel_international" });
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — validity-window calculation
// ---------------------------------------------------------------------------

describe("RL-012 stage 5: validity-window calculation", () => {
  it("carries the travel window verbatim into the command validity", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(
      intent,
      version,
      compileOptionsFixture({ at: "2026-01-20T09:00:00.000Z" }),
    );
    expect(result.payload.validity).toEqual({
      start: "2026-02-01T00:00:00.000Z",
      end: "2026-02-14T00:00:00.000Z",
    });
  });

  it("rejects a window that has fully elapsed at the compile instant", () => {
    const { intent, version } = intentVersionPair();
    expect(() =>
      compiler.compile(intent, version, compileOptionsFixture({ at: "2026-03-01T00:00:00.000Z" })),
    ).toThrow(/elapsed/);
  });

  it("accepts a window still open at the compile instant (boundary: at === end is elapsed)", () => {
    const { intent, version } = intentVersionPair();
    expect(() =>
      compiler.compile(
        intent,
        version,
        compileOptionsFixture({ at: "2026-02-13T23:59:59.999Z" }),
      ),
    ).not.toThrow();
    expect(() =>
      compiler.compile(intent, version, compileOptionsFixture({ at: "2026-02-14T00:00:00.000Z" })),
    ).toThrow(ValidationError);
  });

  it("derives the deterministic termination policy (customer may terminate; release on expiry)", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(result.payload.termination).toEqual({ actor: "customer", onExpiry: "release" });
  });
});

// ---------------------------------------------------------------------------
// Stages 6-7 — canonical serialization + digest stability
// ---------------------------------------------------------------------------

describe("RL-012 stages 6-7: canonical serialization + digest stability", () => {
  it("produces byte-identical canonical JSON and the same digest for identical inputs", () => {
    const { intent, version } = intentVersionPair();
    const options = compileOptionsFixture();
    const a = compiler.compile(intent, version, options);
    const b = compiler.compile(intent, version, options);
    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.digest).toBe(b.digest);
    expect(a.canonicalJson).toEqual(JSON.stringify(JSON.parse(a.canonicalJson)));
  });

  it("computes the digest as the SHA-256 of the canonical model value", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(result.digest).toBe(canonicalJsonDigest(result.canonicalModel));
  });

  it("emits sorted-key canonical JSON (key order is representation-independent)", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    // Re-serialize the parsed value through a canonical sort and compare:
    // identical bytes prove the emitted JSON is already canonical.
    const roundTrip = JSON.parse(result.canonicalJson);
    const resorted = JSON.stringify(
      (function sort(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(sort);
        if (value !== null && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
              x < y ? -1 : x > y ? 1 : 0,
            ).map(([k, v]) => [k, sort(v)]),
          );
        }
        return value;
      })(roundTrip),
    );
    expect(result.canonicalJson).toBe(resorted);
  });

  it("different payloads produce different digests", () => {
    const base = intentVersionPair();
    const varied = intentVersionPair({
      payload: payloadFixture({
        preferences: {
          reliability: "mission_critical",
          latency: "interactive",
          costSensitivity: "medium",
          privacySensitivity: "high",
          preferredAccessClasses: ["trusted_wifi", "open_wifi", "roaming_cellular"],
        },
      }),
    });
    const options = compileOptionsFixture();
    const a = compiler.compile(base.intent, base.version, options);
    const b = compiler.compile(varied.intent, varied.version, options);
    expect(a.digest).not.toBe(b.digest);
  });

  it("the digest is independent of the command instant and command id (content identity)", () => {
    const { intent, version } = intentVersionPair();
    const a = compiler.compile(intent, version, compileOptionsFixture());
    const b = compiler.compile(
      intent,
      version,
      compileOptionsFixture({
        at: "2026-01-21T10:00:00.000Z",
        commandId: "00000000-0000-4000-8000-0000000000d4",
      }),
    );
    expect(a.digest).toBe(b.digest);
    expect(a.envelope.commandId).not.toBe(b.envelope.commandId);
  });
});

// ---------------------------------------------------------------------------
// Stage 8 — command creation + traceability
// ---------------------------------------------------------------------------

describe("RL-012 stage 8: ADCOS ConnectivityIntent command creation", () => {
  it("preserves the source ExperienceIntent id + version for traceability", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(result.payload.sourceIntentId).toBe(version.intentId);
    expect(result.payload.sourceIntentVersionId).toBe(version.intentVersionId);
    expect(result.payload.sourceIntentVersionNumber).toBe(version.versionNumber);
    expect(result.model.source.intentId).toBe(version.intentId);
    expect(result.model.source.versionNumber).toBe(1);
  });

  it("carries the intent version number in the §5 envelope (intentVersion slot)", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(result.envelope.intentVersion).toBe(version.versionNumber);
    expect(result.envelope.tenantId).toBe(intent.tenantId);
    expect(result.envelope.createdAt).toBe(parseUtcInstant("2026-01-20T09:00:00.000Z"));
    expect(result.envelope.retry.attempt).toBe(1);
  });

  it("defaults the actor to the intent owner and allows an explicit override", () => {
    const { intent, version } = intentVersionPair();
    const own = compiler.compile(intent, version, compileOptionsFixture());
    expect(own.envelope.actorId).toBe(intent.ownerUserId);
    const overridden = compiler.compile(
      intent,
      version,
      compileOptionsFixture({ actorId: "svc:intent-compiler" }),
    );
    expect(overridden.envelope.actorId).toBe("svc:intent-compiler");
    expect(overridden.payload.actorId).toBe("svc:intent-compiler");
  });

  it("derives the idempotency key and correlation id deterministically", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    const expectedKey = `idem.intent.${version.intentVersionId}.${result.digest.slice(0, 16)}`;
    expect(result.envelope.idempotencyKey).toBe(expectedKey);
    expect(result.envelope.correlationId).toBe(`corr.intent.${version.intentVersionId}`);
  });

  it("honors explicit correlation/idempotency/attempt overrides", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(
      intent,
      version,
      compileOptionsFixture({
        correlationId: "corr-explicit-1",
        idempotencyKey: "idem-explicit-1",
        attempt: 3,
      }),
    );
    expect(result.envelope.correlationId).toBe("corr-explicit-1");
    expect(result.envelope.idempotencyKey).toBe("idem-explicit-1");
    expect(result.envelope.retry.attempt).toBe(3);
  });

  it("the payload field set is exactly the closed command vocabulary (RL-031 compatibility pin)", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(Object.keys(result.payload).sort()).toEqual(
      [...CONNECTIVITY_INTENT_COMMAND_FIELDS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Pinned structural compatibility with the integration-side intent command
// (packages/integration intent-command.ts; keep in sync when that side
// evolves — this package deliberately has NO dependency edge to it).
// ---------------------------------------------------------------------------

describe("RL-012 structural compatibility with the RL-031 intent command input", () => {
  // The closed IntentCommandInput field list, as documented by the
  // integration package (packages/integration/src/intent-command.ts).
  const INTENT_COMMAND_INPUT_FIELDS = [
    "sourceIntentId",
    "sourceIntentVersionId",
    "sourceIntentVersionNumber",
    "actorId",
    "tenantId",
    "requirements",
    "validity",
    "termination",
    "beneficiaries",
    "serviceProperties",
    "usagePricingTerms",
    "assuranceObligations",
    "executionScope",
    "supersededContract",
  ] as const;

  it("every emitted payload field is accepted by the integration-side closed schema", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    for (const key of Object.keys(result.payload)) {
      expect(INTENT_COMMAND_INPUT_FIELDS).toContain(key);
    }
  });

  it("requirement statements use the closed integration-side dimension vocabulary", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    for (const requirement of result.model.requirements) {
      expect(INTENT_DIMENSIONS).toContain(requirement.dimension);
      expect(Object.keys(requirement).sort()).toEqual([
        "classification",
        "dimension",
        "statement",
      ]);
    }
  });

  it("termination uses the integration-side actor/onExpiry vocabularies", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(["customer", "roamlink", "adcos"]).toContain(result.payload.termination.actor);
    expect(["release", "renew"]).toContain(result.payload.termination.onExpiry);
  });
});

// ---------------------------------------------------------------------------
// Determinism + purity
// ---------------------------------------------------------------------------

describe("RL-012 determinism and purity", () => {
  it("the functional and class forms produce identical outputs", () => {
    const { intent, version } = intentVersionPair();
    const options = compileOptionsFixture();
    const viaClass = compiler.compile(intent, version, options);
    const viaFunction = compileExperienceIntent(intent, version, options);
    expect(viaFunction).toEqual(viaClass);
  });

  it("deep-equal inputs from separately built records produce identical digests", () => {
    const a = intentVersionPair();
    const b = intentVersionPair();
    const options = compileOptionsFixture();
    const first = compiler.compile(a.intent, a.version, options);
    const second = compiler.compile(b.intent, b.version, options);
    expect(second.digest).toBe(first.digest);
    expect(second.canonicalJson).toBe(first.canonicalJson);
    expect(second.envelope.digest()).toBe(first.envelope.digest());
  });

  it("the output is deeply frozen (immutable compiled artifacts)", () => {
    const { intent, version } = intentVersionPair();
    const result = compiler.compile(intent, version, compileOptionsFixture());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.model)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(Object.isFrozen(result.model.requirements)).toBe(true);
  });

  it("compiling does not mutate the input records", () => {
    const { intent, version } = intentVersionPair();
    const intentBefore = structuredClone(intent);
    const versionBefore = structuredClone(version);
    compiler.compile(intent, version, compileOptionsFixture());
    expect(intent).toEqual(intentBefore);
    expect(version).toEqual(versionBefore);
  });
});
