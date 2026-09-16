/**
 * RL-050 tests: the value-free access observer (the RL-051 audit seam) and
 * the byte-key provider adapter (the RL-042 wiring seam).
 */
import { describe, expect, it } from "vitest";

import {
  InMemorySecrets,
  createSecretBytesKeyProvider,
  keyRef,
  withSecretAccessObserver,
} from "../src/index.js";
import type { SecretAccessNotification } from "../src/index.js";
import { parseSecretRef } from "../src/index.js";
import { DeterministicClock } from "@roamlink/testkit";
import { fixtureUtcInstant } from "@roamlink/testkit";

describe("withSecretAccessObserver", () => {
  it("notifies resolved attempts with the concrete version and never the value", async () => {
    const notifications: SecretAccessNotification[] = [];
    const clock = new DeterministicClock(fixtureUtcInstant());
    const store = new InMemorySecrets();
    store.register("svc.api", "v1-material");
    const resolver = withSecretAccessObserver(store, (n) => notifications.push(n), () => clock.now());

    await resolver.resolve(parseSecretRef({ name: "svc.api" }));
    expect(notifications).toEqual([
      {
        ref: parseSecretRef({ name: "svc.api" }),
        resolvedVersion: 1,
        outcome: "resolved",
        at: clock.now(),
      },
    ]);
    expect(JSON.stringify(notifications)).not.toContain("v1-material");
  });

  it("notifies failed attempts with typed outcomes and null version", async () => {
    const notifications: SecretAccessNotification[] = [];
    const store = new InMemorySecrets();
    store.register("svc.api", "v1-material");
    const resolver = withSecretAccessObserver(store, (n) => notifications.push(n));

    await expect(
      resolver.resolve(parseSecretRef({ name: "nope" })),
    ).rejects.toMatchObject({ reason: "SECRET_UNKNOWN" });
    store.setUnavailable("svc.api");
    await expect(
      resolver.resolve(parseSecretRef({ name: "svc.api" })),
    ).rejects.toMatchObject({ reason: "SECRET_UNAVAILABLE" });
    expect(notifications.map((n) => n.outcome)).toEqual(["unknown", "unavailable"]);
    expect(notifications.every((n) => n.resolvedVersion === null)).toBe(true);
  });
});

describe("createSecretBytesKeyProvider (RL-042 seam)", () => {
  it("returns active-version material as UTF-8 bytes keyed by safe-label key id", async () => {
    const store = new InMemorySecrets();
    store.register("edge-sync-key", "0123456789abcdef0123456789abcdef");
    const provider = createSecretBytesKeyProvider(store);
    const bytes = await provider("edge-sync-key");
    expect(new TextDecoder().decode(bytes)).toBe("0123456789abcdef0123456789abcdef");
  });

  it("follows rotation for future fetches while keyRef stays value-free", async () => {
    const store = new InMemorySecrets();
    store.register("edge-sync-key", "first-key-material-32-bytes-aaaaaaaa");
    const provider = createSecretBytesKeyProvider(store);
    expect(new TextDecoder().decode(await provider("edge-sync-key"))).toBe(
      "first-key-material-32-bytes-aaaaaaaa",
    );
    store.rotate("edge-sync-key", "second-key-material-32-bytes-bbbbbbb");
    expect(new TextDecoder().decode(await provider("edge-sync-key"))).toBe(
      "second-key-material-32-bytes-bbbbbbb",
    );
    expect(JSON.stringify(keyRef("edge-sync-key"))).not.toContain("material");
  });

  it("fails typed (SECRET_UNKNOWN) for unmapped key ids", async () => {
    const provider = createSecretBytesKeyProvider(new InMemorySecrets());
    await expect(provider("unregistered-key")).rejects.toMatchObject({ reason: "SECRET_UNKNOWN" });
  });

  it("rejects unsafe key ids before touching the resolver", async () => {
    const provider = createSecretBytesKeyProvider(new InMemorySecrets());
    await expect(provider("bad key id!")).rejects.toThrow(/safe labels/);
  });
});
