/**
 * RL-074 suite 5: AUDIT-CHAIN INTEGRITY (RL-051; spec/security.md "Audit":
 * "Record security-relevant mutations with actor, tenant, command,
 * correlation ID, target resource, authorization decision, timestamp and
 * outcome"; RL-LOCK-014 correlation).
 *
 * Threat model: an attacker (or a silent corruption) rewrites history.
 * The digest chain (SHA-256 over canonical JSON, per-log monotonic
 * sequence + prevDigest linkage) must detect every mutation/reorder/splice
 * that does not rewrite the ENTIRE subsequent tail.
 *
 * Attack catalog:
 *   I-1  field mutation on one recorded event -> digest-mismatch at that
 *        sequence;
 *   I-2  reordering two events -> chain-broken at the first inconsistency;
 *   I-3  splicing an event OUT of the middle -> sequence-invalid;
 *   I-4  injecting an unknown field -> digest-mismatch (closed field set);
 *   I-5  the FULL-TAIL REWRITE attack (attacker recomputes every digest):
 *        the hash chain alone CANNOT detect it - the package's own
 *        documented KNOWN LIMIT. Pinned honestly (external anchoring is
 *        future work; see the docs threat matrix);
 *   I-6  security-relevant mutations always produce audit events carrying
 *        actor/tenant/correlation (enterprise key lifecycle, retention
 *        decisions, admin commands and denials through the app surface);
 *   I-7  the audit stream is append-only by construction (no mutation
 *        method exists on the port or the reference store);
 *   I-8  query discipline (correlation/actor/tenant/category/time-range;
 *        closed category vocabulary).
 */
import { describe, expect, it } from "vitest";
import {
  ValidationError,
  parseCorrelationId,
  parseTenantId,
  parseUtcInstant,
  type Digest,
} from "@roamlink/contracts";
import { InMemoryAuditLog, verifyAuditChain } from "@roamlink/audit";
import type { AuditEventPlain } from "@roamlink/audit";
import { createEnterpriseApiHarness } from "@roamlink/enterprise";
import {
  PersistenceRetentionRecordStore,
  RetentionEnforcementEngine,
} from "@roamlink/retention";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { T0, instantPlusMs, makeSecurityWorld, registerPrincipal } from "../src/harness.js";

/** Builds an audit log pre-filled with a deterministic security history. */
async function filledLog(): Promise<{
  readonly log: InMemoryAuditLog;
  readonly events: readonly AuditEventPlain[];
}> {
  const log = new InMemoryAuditLog({
    eventIdGenerator: (() => {
      let counter = 0;
      return () =>
        `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
    })(),
  });
  for (let index = 1; index <= 5; index += 1) {
    await log.append({
      category: "auth",
      action: `session.event-${index}`,
      outcome: index % 2 === 0 ? "denied" : "allowed",
      actorId: "usr:00000000-0000-4000-8000-0000000000a1",
      tenantId: "usr:00000000-0000-4000-8000-0000000000a1",
      correlationId: `corr.audit.chain.${index}`,
      ...(index === 3 ? { commandId: "11111111-1111-4111-8111-1111111111a3" } : {}),
      ...(index === 3 ? { target: "session:00000000-0000-4000-8000-0000000000b1" } : {}),
      occurredAt: instantPlusMs(T0, index * 1_000),
      ...(index === 3 ? { detail: "boundary authorization decision" } : {}),
    });
  }
  const verification = await log.verify();
  if (!verification.ok) throw new Error("expected the fresh chain to verify");
  const events = (await log.events()).map((event) => event.toPlain());
  return { log, events };
}

/** JSON round-trip (the serialization an attacker or a restore path sees). */
function roundTrip(events: readonly AuditEventPlain[]): AuditEventPlain[] {
  return JSON.parse(JSON.stringify(events)) as AuditEventPlain[];
}

describe("RL-074 suite 5: audit-chain tamper detection", () => {
  it("I-1 mutating one recorded field breaks verification at exactly that sequence", async () => {
    const { events } = await filledLog();
    const tampered = roundTrip(events);
    // The attacker flips an authorization outcome.
    (tampered[1] as { outcome: string }).outcome = "allowed";
    const verification = verifyAuditChain(tampered);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.reason).toBe("digest-mismatch");
      expect(verification.firstBrokenSequence).toBe(2);
    }
  });

  it("I-2 reordering two events breaks the prevDigest linkage", async () => {
    const { events } = await filledLog();
    const reordered = roundTrip(events);
    const second = reordered[1];
    const third = reordered[2];
    if (second === undefined || third === undefined) throw new Error("unreachable");
    reordered[1] = third;
    reordered[2] = second;
    const verification = verifyAuditChain(reordered);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(
        verification.reason === "chain-broken" ||
          verification.reason === "digest-mismatch" ||
          verification.reason === "sequence-invalid",
      ).toBe(true);
      expect(verification.firstBrokenSequence).toBe(2);
    }
  });

  it("I-3 splicing an event out of the middle is detected (sequence or linkage)", async () => {
    const { events } = await filledLog();
    const spliced = roundTrip(events);
    spliced.splice(2, 1); // remove the third event
    const verification = verifyAuditChain(spliced);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(
        verification.reason === "sequence-invalid" || verification.reason === "chain-broken",
      ).toBe(true);
    }
  });

  it("I-4 injecting an unknown field is detected (closed field set)", async () => {
    const { events } = await filledLog();
    const injected = roundTrip(events);
    (injected[4] as unknown as Record<string, unknown>)["exfiltrated"] = "attacker-payload";
    const verification = verifyAuditChain(injected);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.reason).toBe("digest-mismatch");
      expect(verification.firstBrokenSequence).toBe(5);
    }
  });

  it("I-5 the FULL-TAIL REWRITE attack is the documented chain limit (pinned honestly)", async () => {
    const { log, events } = await filledLog();
    const rewritten = roundTrip(events);
    // The attacker erases history's inconvenient fact...
    (rewritten[1] as { outcome: string }).outcome = "allowed";

    // ...and recomputes EVERY digest from the genesis (a full tail rewrite
    // with full knowledge of the hash scheme). A bare hash chain cannot
    // detect this: the package's own KNOWN LIMIT (external digest
    // anchoring/checkpointing is future work). We pin the limit EXACTLY so
    // the fix flips this assertion.
    const { auditEventDigest } = await import("@roamlink/audit");
    let previousDigest: string | null = null;
    for (let index = 0; index < rewritten.length; index += 1) {
      const record = rewritten[index];
      if (record === undefined) throw new Error("unreachable");
      const withPrev = { ...record, prevDigest: previousDigest as Digest | null };
      const { digest: _omit, ...body } = withPrev;
      const recomputed = auditEventDigest(body as never);
      rewritten[index] = { ...withPrev, digest: recomputed };
      previousDigest = recomputed;
    }
    const verification = verifyAuditChain(rewritten);
    // PINNED CURRENT BEHAVIOR (the limit): the fully rewritten tail
    // verifies. THE HONEST GAP - recorded in docs/threat-model-verification.md.
    expect(verification.ok).toBe(true);
    // ...while the STORE's own chain (untampered) still verifies too.
    expect((await log.verify()).ok).toBe(true);
  });

  it("I-6 security-relevant mutations produce audit events carrying actor/tenant/correlation", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x80);

    // --- Enterprise API-key lifecycle: every decision audited.
    const harness = createEnterpriseApiHarness({ now: () => world.clock.now() });
    const tenant = "org:77777777-0000-4000-8000-000000000001";
    const issuance = await harness.apiKeys.issue(
      { tenantId: tenant, name: "audit-key", scopes: ["enrollments:manage"] },
      {
        commandId: "99999999-0000-4000-8000-000000000081",
        correlationId: "corr.audit.enterprise.key",
        idempotencyKey: "idem.audit.enterprise.key",
        actorId: "actor-audit",
      },
      world.clock.now(),
    );
    await harness.apiKeys.rotate(
      issuance.record.keyId,
      tenant,
      {
        commandId: "99999999-0000-4000-8000-000000000082",
        correlationId: "corr.audit.enterprise.rotate",
        idempotencyKey: "idem.audit.enterprise.rotate",
        actorId: "actor-audit",
      },
      world.clock.now(),
    );
    const keyAudits = await harness.audit.query({ correlationId: parseCorrelationId("corr.audit.enterprise.key") });
    expect(keyAudits.length).toBeGreaterThan(0);
    for (const event of await harness.audit.events()) {
      expect(event.actorId).toBeDefined();
      expect(event.correlationId).toBeDefined();
      if (event.tenantId !== undefined) {
        expect(event.tenantId).toBe(tenant);
      }
    }
    expect((await harness.audit.verify()).ok).toBe(true);

    // --- Retention decisions: atomic audit rows with the tenant boundary.
    const persistence = createInMemoryPersistence();
    const engine = new RetentionEnforcementEngine({
      persistence,
      policy: (await import("@roamlink/retention")).DEFAULT_RETENTION_POLICY,
      recordStore: new PersistenceRetentionRecordStore(persistence, persistence, (await import("@roamlink/retention")).DEFAULT_RETENTION_POLICY),
      decisionIdGenerator: (() => {
        let counter = 0;
        return () =>
          `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
      })(),
    });
    await engine.admit(
      {
        recordId: "ret:audit-record-1",
        tenantId: principal.tenantId,
        dataCategory: "diagnostics",
        purposes: ["diagnostics"],
        collectedAt: world.clock.now(),
        consent: false,
        payload: { note: "honest diagnostics" },
      },
      world.clock.now(),
    );
    const { RETENTION_AUDIT_REPOSITORY } = await import("@roamlink/retention");
    const auditRows = await persistence.records(RETENTION_AUDIT_REPOSITORY).list();
    expect(auditRows.length).toBe(1);
    const decision = auditRows[0]?.value as Record<string, unknown>;
    expect(decision["tenantId"]).toBe(principal.tenantId);
    expect(decision["decision"]).toBe("retained");

    // --- The app surface: commands and DENIALS audited on the API's own
    // digest chain (verified through the admin read surface).
    const { createInMemoryApi, fakeApiSeed, RoamLinkApiClient } = await import("@roamlink/app-kit");
    const { SequenceIdGenerator } = await import("@roamlink/testkit");
    const seed = fakeApiSeed();
    const firstTenantKey = Object.keys(seed.tenants)[0];
    if (firstTenantKey === undefined) throw new Error("seed has no tenants");
    const template = seed.tenants[firstTenantKey];
    if (template === undefined) throw new Error("seed has no tenants");
    const firstTenant = firstTenantKey;
    const OWNER = "usr:eeeeeeee-0000-4000-8000-000000000001";
    const api = createInMemoryApi(
      {
        users: [{ userId: OWNER.slice(4), displayName: "Eve Owner" }],
        catalog: seed.catalog,
        tenants: {
          [firstTenant]: {
            ...template,
            organization: {
              ...template.organization,
              members: [
                { userId: OWNER.slice(4), role: "owner" as const, status: "active" as const },
              ],
            },
          } as never,
        },
      },
      { now: () => T0, ids: (() => { let counter = 0; return () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`; })() },
    );
    const client = new RoamLinkApiClient({
      transport: api.transport,
      actor: { actorId: OWNER, tenantId: firstTenant },
      ids: new SequenceIdGenerator({ prefix: "a-" }),
    });
    // Drive one real mutation through the surface: the enrollment is an
    // authority-decision audit event with actor + correlation.
    await client.enrollDevice(
      { name: "Audit Phone", platform: "ios" },
      { idempotencyKey: "idem.audit.app.enroll", correlationId: "corr.audit.app.enroll" },
    );
    const auditView = await client.listAuditEvents();
    expect(auditView.chain.verified).toBe(true);
    expect(auditView.events.length).toBeGreaterThan(0);
    const enrollEvent = auditView.events.find((event) =>
      event.action.includes("device.enroll"),
    );
    expect(enrollEvent).toBeDefined();
    if (enrollEvent === undefined) throw new Error("expected the enroll audit event");
    expect(enrollEvent.actorId).toBe(OWNER);
    expect(enrollEvent.correlationId).toBe("corr.audit.app.enroll");
    expect(enrollEvent.outcome).toBe("allowed");
    for (const event of auditView.events) {
      expect(event.actorId).toBeDefined();
      expect(event.correlationId).toBeDefined();
    }
  });

  it("I-7 the audit stream is append-only by construction (no mutation method exists)", async () => {
    const { log } = await filledLog();
    const forbidden = ["update", "delete", "remove", "truncate", "clear", "edit", "patch", "put"];
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(log)).concat(
      Object.getOwnPropertyNames(log),
    );
    for (const name of forbidden) {
      expect(methodNames, `an audit log must not expose '${name}'`).not.toContain(name);
    }
    // The events themselves are deeply frozen records: a strict-mode
    // assignment onto a frozen field throws (ES modules are strict).
    const events = await log.events();
    expect(Object.isFrozen(events)).toBe(true);
    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true);
      expect(() => {
        (event as unknown as Record<string, unknown>)["outcome"] = "allowed";
      }).toThrowError(TypeError);
    }
  });

  it("I-8 queries are validated and closed-vocabulary", async () => {
    const { log } = await filledLog();
    // Closed category vocabulary (the query validates before reading).
    await expect(log.query({ category: "not-a-category" })).rejects.toThrowError(ValidationError);
    // Correlation query finds exactly the one event.
    const byCorrelation = await log.query({ correlationId: parseCorrelationId("corr.audit.chain.3") });
    expect(byCorrelation).toHaveLength(1);
    expect(byCorrelation[0]?.sequence).toBe(3);
    // Tenant + time-range queries compose (AND).
    const tenant = "usr:00000000-0000-4000-8000-0000000000a1";
    const byTenant = await log.query({ tenantId: parseTenantId(tenant) });
    expect(byTenant).toHaveLength(5);
    const sliced = await log.query({
      tenantId: parseTenantId(tenant),
      from: parseUtcInstant(instantPlusMs(T0, 2_500)),
      to: parseUtcInstant(instantPlusMs(T0, 3_500)),
    });
    expect(sliced).toHaveLength(1);
    expect(sliced[0]?.sequence).toBe(3);
  });
});
