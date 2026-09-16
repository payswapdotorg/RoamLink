/**
 * RL-050 tests: secret references, material redaction, resolution failure
 * modes, rotation versioning - with explicit NO-VALUE-IN-ERROR/LOG/SERIALIZED-
 * STATE proofs (RL-LOCK-016, spec/definition-of-done.md Security).
 */
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";

import {
  InMemorySecrets,
  REDACTED_SECRET_PLACEHOLDER,
  SecretMaterial,
  describeSecretRef,
  isSecretName,
  makeResolvedSecret,
  parseSecretName,
  parseSecretRef,
} from "../src/index.js";

const RAW = "test-secret-value-do-not-leak-0123456789";

describe("SecretRef", () => {
  it("parses a floating (active) reference", () => {
    const ref = parseSecretRef({ name: "ADCOS_CLIENT_SECRET" });
    expect(ref.name).toBe("ADCOS_CLIENT_SECRET");
    expect(ref.version).toBeNull();
    expect(Object.isFrozen(ref)).toBe(true);
  });

  it("parses a pinned reference", () => {
    const ref = parseSecretRef({ name: "sync.key", version: 3 });
    expect(ref.version).toBe(3);
  });

  it("rejects unsafe names, non-positive versions and unknown fields", () => {
    expect(() => parseSecretRef({ name: "bad name!" })).toThrow(/SecretName/);
    expect(() => parseSecretRef({ name: "ok", version: 0 })).toThrow(/version/);
    expect(() => parseSecretRef({ name: "ok", version: 1.5 })).toThrow(/version/);
    expect(() => parseSecretRef({ name: "ok", version: 1, extra: true })).toThrow(/unknown field/);
    expect(() => parseSecretName("")).toThrow(/safe label/);
    expect(isSecretName("good-name.1")).toBe(true);
    expect(isSecretName("nope nope")).toBe(false);
  });

  it("describes refs value-free for logs", () => {
    expect(describeSecretRef(parseSecretRef({ name: "s" }))).toBe("s@active");
    expect(describeSecretRef(parseSecretRef({ name: "s", version: 2 }))).toBe("s@v2");
  });
});

describe("SecretMaterial redaction (RL-LOCK-016)", () => {
  it("exposes the value ONLY through the accessor", () => {
    const material = new SecretMaterial(RAW);
    expect(material.value).toBe(RAW);
  });

  it("never serializes the value (stringify/toString/inspect)", () => {
    const material = new SecretMaterial(RAW);
    expect(String(material)).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(JSON.stringify(material)).not.toContain(RAW);
    expect(inspect(material)).not.toContain(RAW);
    const record = { secret: material };
    expect(JSON.stringify(record)).not.toContain(RAW);
    expect(JSON.stringify(record)).toContain(REDACTED_SECRET_PLACEHOLDER);
  });

  it("rejects empty / oversized / non-string material", () => {
    expect(() => new SecretMaterial("")).toThrow(/non-empty/);
    expect(() => new SecretMaterial(("x".repeat(8193)) as string)).toThrow(/at most/);
    expect(() => new SecretMaterial(42 as unknown as string)).toThrow(/non-empty/);
  });

  it("resolves to UTF-8 bytes for the crypto boundary", () => {
    const bytes = new SecretMaterial(RAW).asUtf8Bytes();
    expect(new TextDecoder().decode(bytes)).toBe(RAW);
  });

  it("resolved secrets serialize without the value", () => {
    const resolved = makeResolvedSecret({ name: "s", version: 1, material: new SecretMaterial(RAW) });
    expect(JSON.stringify(resolved)).not.toContain(RAW);
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});

describe("InMemorySecrets resolution + failure modes", () => {
  it("resolves the active version; pinned resolves exactly that version", async () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", "v1-material");
    const active = await secrets.resolve(parseSecretRef({ name: "svc.api" }));
    expect(active.version).toBe(1);
    expect(active.material.value).toBe("v1-material");
    const pinned = await secrets.resolve(parseSecretRef({ name: "svc.api", version: 1 }));
    expect(pinned.version).toBe(1);
    await expect(secrets.activeVersion(parseSecretName("svc.api"))).resolves.toBe(1);
  });

  it("fails SECRET_UNKNOWN for unregistered names", async () => {
    const secrets = new InMemorySecrets();
    const error = await secrets.resolve(parseSecretRef({ name: "missing" })).catch((e) => e);
    expect(error.kind).toBe("not-found");
    expect(error.reason).toBe("SECRET_UNKNOWN");
    expect(error.message).not.toContain(RAW);
  });

  it("fails SECRET_VERSION_UNKNOWN for versions that never existed", async () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", "v1-material");
    const error = await secrets
      .resolve(parseSecretRef({ name: "svc.api", version: 9 }))
      .catch((e) => e);
    expect(error.reason).toBe("SECRET_VERSION_UNKNOWN");
  });

  it("fails SECRET_UNAVAILABLE (retryable) after setUnavailable", async () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", "v1-material");
    secrets.setUnavailable("svc.api");
    const error = await secrets.resolve(parseSecretRef({ name: "svc.api" })).catch((e) => e);
    expect(error.reason).toBe("SECRET_UNAVAILABLE");
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(typeof error.retryAfterMs).toBe("number");
  });

  it("fails SECRET_ACCESS_FORBIDDEN when the guard denies the caller", async () => {
    const secrets = new InMemorySecrets({ accessGuard: (ref) => ref.name !== "restricted" });
    secrets.register("restricted", "secret-material");
    const error = await secrets.resolve(parseSecretRef({ name: "restricted" })).catch((e) => e);
    expect(error.reason).toBe("SECRET_ACCESS_FORBIDDEN");
    expect(error.kind).toBe("unauthorized");
    expect(error.message).not.toContain("secret-material");
  });

  it("no failure-mode message ever contains the material", async () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", RAW);
    secrets.setUnavailable("svc.api");
    const error = await secrets.resolve(parseSecretRef({ name: "svc.api" })).catch((e) => e);
    const serialized = JSON.stringify(error.toJSON?.() ?? { message: String(error) });
    expect(serialized).not.toContain(RAW);
  });
});

describe("rotation-aware versioning", () => {
  it("rotate appends a version, moves active, keeps old resolvable until retired", async () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", "v1-material");
    expect(secrets.rotate("svc.api", "v2-material")).toBe(2);
    await expect(secrets.activeVersion(parseSecretName("svc.api"))).resolves.toBe(2);
    // floating resolves the new active
    await expect(secrets.resolve(parseSecretRef({ name: "svc.api" }))).resolves.toMatchObject({
      version: 2,
    });
    // pinned v1 still resolves (rotation does not strand pinned consumers)
    await expect(secrets.resolve(parseSecretRef({ name: "svc.api", version: 1 }))).resolves.toMatchObject(
      { version: 1 },
    );
    secrets.retire("svc.api", 1);
    const error = await secrets
      .resolve(parseSecretRef({ name: "svc.api", version: 1 }))
      .catch((e) => e);
    expect(error.reason).toBe("SECRET_VERSION_RETIRED");
    expect(error.kind).toBe("stale-state");
    expect(error.message).toContain("re-resolve");
  });

  it("retiring the ACTIVE version is rejected (rotate first - fail-closed)", () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", "v1-material");
    secrets.rotate("svc.api", "v2-material");
    expect(() => secrets.retire("svc.api", 2)).toThrow(/ACTIVE/);
  });

  it("register enforces monotonic versions and rejects duplicates", () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", "v1-material");
    expect(() => secrets.register("svc.api", "again", { version: 1 })).toThrow(/already/);
    expect(() => secrets.register("svc.api", "skip", { version: 3 })).toThrow(/monotonic/);
    expect(() => secrets.rotate("other.svc", "x")).toThrow(/not registered/);
  });

  it("metadata views are value-free", () => {
    const secrets = new InMemorySecrets();
    secrets.register("svc.api", RAW);
    secrets.rotate("svc.api", "v2");
    secrets.retire("svc.api", 1);
    const described = JSON.stringify(secrets.describe());
    expect(described).not.toContain(RAW);
    expect(described).not.toContain("v2-material");
    expect(described).toContain("svc.api");
    const view = secrets.describe()[0];
    expect(view?.registeredVersions).toEqual([1, 2]);
    expect(view?.retiredVersions).toEqual([1]);
    expect(view?.activeVersion).toBe(2);
  });
});
