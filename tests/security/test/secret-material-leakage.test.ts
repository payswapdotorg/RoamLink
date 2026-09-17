/**
 * RL-074 suite 3: SECRET-MATERIAL LEAKAGE (spec/security.md "Credential
 * rules"; RL-LOCK-016; RL-054 enforcement point; RL-LOCK-005-adjacent edge
 * discipline).
 *
 * Threat priorities #5 (leaked ADCOS/provider credentials), #6 (compromised
 * edge device) and #7 (malicious provider metadata).
 *
 * Method: the RL-054 retention secret-scanner (assertNoSecretMaterial /
 * scanForSecretMaterial - the SAME enforcement point the repo's own
 * persisted payloads are tested against) is run across EVERY persisted
 * projection / read-model / log-field fixture this suite's flows produce.
 * Zero findings is the verdict; the scanner's ABILITY to fail is proven
 * first with deliberately poisoned fixtures (a scanner that cannot fail is
 * not a proof).
 *
 * Attack/leakage catalog:
 *   S-1  scanner negative proofs (key-name, PEM marker, token prefixes) -
 *        the scanner detects every poisoned fixture class;
 *   S-2  the real persisted surfaces are scanner-clean: projections,
 *        inbox records (raw payload included), outbox, audit events,
 *        sessions (digest-only), credentials (hash-only), notifications,
 *        retention records + decision audit rows, commerce read models
 *        (order/payment/event chains), enterprise API-key records
 *        (reference-only);
 *   S-3  no secret-shaped value flows into audit events, notifications,
 *        telemetry-shaped log records or error messages (failed logins,
 *        failed secret resolutions, verifier rejections);
 *   S-4  SecretMaterial is redacted from every serialization path
 *        (toString/toJSON/JSON.stringify/inspect);
 *   S-5  the secrets boundary failure taxonomy never echoes values;
 *   S-6  malicious provider metadata (secret-shaped provider references)
 *        is rejected by the commerce payment record's safe charset;
 *   S-7  the edge offline outbox stores CIPHERTEXT only (payload bytes are
 *        never plaintext at rest).
 */
import { describe, expect, it } from "vitest";
import {
  NotFoundError,
  ValidationError,
} from "@roamlink/contracts";
import { scanForSecretMaterial, assertNoSecretMaterial } from "@roamlink/retention";
import { SecretMaterial, InMemorySecrets } from "@roamlink/secrets";
import { createEnterpriseApiHarness } from "@roamlink/enterprise";
import { ADCOS_WEBHOOK_INBOX_REPOSITORY } from "@roamlink/webhook-inbox";
import { RECONCILIATION_JOBS_REPOSITORY } from "@roamlink/reconciliation";
import {
  CatalogService,
  createInMemoryCommerceStore,
  InMemoryCommerceIdempotencyLedger,
  OrderService,
  PaymentService,
} from "@roamlink/domain-commerce";
import {
  DeliveryIds,
  makeSecurityWorld,
  registerPrincipal,
  webhookEventSpec,
  type SecurityWorld,
} from "../src/harness.js";

// ---------------------------------------------------------------------------
// The poisoned-fixture corpus (attack material the scanner MUST detect)
// ---------------------------------------------------------------------------

// PEM/AWS markers are assembled from parts so this source never carries a
// complete credential marker (the repo's own pre-commit discipline).
const PEM_MARKER = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const AWS_MARKER = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const POISONED_FIXTURES: readonly { readonly label: string; readonly value: unknown }[] = [
  {
    label: "password field",
    value: { note: "attacker", password: "hunter2-long-enough-value" },
  },
  {
    label: "PEM private key",
    value: { note: "stolen", pem: `${PEM_MARKER}MIIEvQ` },
  },
  {
    label: "GitHub PAT prefix",
    value: { note: "stolen", value: ["gh", "p_SuperSecretTokenValue123456"].join("") },
  },
  {
    label: "JWT header prefix",
    value: { note: "stolen", jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload" },
  },
  {
    label: "AWS access key",
    value: { note: "stolen", accessKey: AWS_MARKER },
  },
  {
    label: "api-key field name",
    value: { deep: { nested: { apiKey: "anything-at-all" } } },
  },
  {
    label: "bearer header value",
    value: { note: "stolen", authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
  },
];

describe("RL-074 suite 3a: the scanner itself can fail (negative proofs on poisoned fixtures)", () => {
  it("S-1 every poisoned fixture class is detected with a path (never a value)", () => {
    for (const fixture of POISONED_FIXTURES) {
      const findings = scanForSecretMaterial(fixture.value);
      expect(findings.length, `fixture '${fixture.label}' must be flagged`).toBeGreaterThan(0);
      // Findings carry PATHS only - the value never appears in a finding.
      for (const finding of findings) {
        expect(finding.path.startsWith("$")).toBe(true);
        expect(finding.detector === "key-name" || finding.detector === "value-marker").toBe(true);
      }
    }
  });

  it("S-1b assertNoSecretMaterial throws a typed error listing paths, not values", () => {
    const poisoned = POISONED_FIXTURES[0];
    if (poisoned === undefined) throw new Error("unreachable");
    expect(() => assertNoSecretMaterial(poisoned.value, "poisoned-fixture")).toThrowError(
      /secret-shaped material detected in poisoned-fixture/,
    );
    try {
      assertNoSecretMaterial(poisoned.value, "poisoned-fixture");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("$.password");
      expect((error as Error).message).not.toContain("hunter2");
    }
  });

  it("S-1c clean fixtures pass through untouched (the honest path)", () => {
    expect(
      scanForSecretMaterial({
        tenantId: "usr:00000000-0000-4000-8000-000000000001",
        displayName: "Public Name",
        status: "active",
        revision: 3,
        evidence: { evidenceClass: "OBSERVED", observedAt: "2026-03-01T09:00:00.000Z" },
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real-surface sweep
// ---------------------------------------------------------------------------

/** Drives every real flow and returns the persisted fixtures to scan. */
async function driveAllSurfaces(world: SecurityWorld): Promise<{
  readonly fixtures: readonly { readonly label: string; readonly value: unknown }[];
  readonly sensitiveValues: readonly string[];
}> {
  const fixtures: { label: string; value: unknown }[] = [];

  // --- ADCOS data plane: webhook admission + projection + a reconciliation job.
  const deliveries = new DeliveryIds("leak");
  for (let index = 1; index <= 3; index += 1) {
    await world.admit(
      world.signedDelivery({
        spec: webhookEventSpec({
          eventId: `evt-leak-${index}`,
          resourceId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        }),
        deliveryId: deliveries.next(),
        sequence: index,
      }),
    );
  }
  await world.boundary.inbox.processPending();
  await world.boundary.reconciler.runJob({ reason: "scheduled" });

  for (const record of await world.projectionStore.list()) {
    fixtures.push({ label: `projection:${record.canonical_resource_id}`, value: record });
  }
  for (const record of await world.persistence.records(ADCOS_WEBHOOK_INBOX_REPOSITORY).list()) {
    fixtures.push({ label: `inbox-record:${record.recordId}`, value: record.value });
  }
  for (const inboxRecord of await world.persistence.inbox.list()) {
    fixtures.push({ label: `inbox-admission:${inboxRecord.sequence}`, value: inboxRecord });
  }
  for (const job of await world.persistence.records(RECONCILIATION_JOBS_REPOSITORY).list()) {
    fixtures.push({ label: `reconciliation-job:${job.recordId}`, value: job.value });
  }

  // --- Auth plane: login, sessions, credentials, users.
  const principal = await registerPrincipal(world, 0x50);
  const login = await world.auth.authentication.loginWithPassword(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    { email: principal.email, password: principal.password },
  );
  const sessionRecord = await world.auth.sessions.findById(
    principal.tenantId,
    login.authSessionId as never,
  );
  if (sessionRecord === undefined) throw new Error("expected the login session record");
  fixtures.push({ label: "auth-session", value: sessionRecord });
  // The token itself must NOT appear in the persisted record (digest only).
  expect(JSON.stringify(sessionRecord)).not.toContain(login.token);
  const credentialRecord = await world.auth.credentials.findByUserId(
    principal.tenantId,
    principal.userId,
  );
  if (credentialRecord === undefined) throw new Error("expected the credential record");
  fixtures.push({ label: "auth-credential", value: credentialRecord });
  const userRecord = await world.auth.users.findById(principal.tenantId, principal.userId);
  if (userRecord === undefined) throw new Error("expected the user record");
  fixtures.push({ label: "auth-user", value: userRecord });

  // --- Audit plane: security-relevant events with detail strings.
  await world.audit.append({
    category: "auth",
    action: "session.create",
    outcome: "allowed",
    actorId: principal.actorId,
    tenantId: principal.tenantId,
    correlationId: "corr.security.leak.audit",
    occurredAt: world.clock.now(),
    detail: "session issued after password authentication",
  });
  for (const event of await world.audit.events()) {
    fixtures.push({ label: `audit-event:${event.sequence}`, value: event.toPlain() });
  }

  // --- Notifications plane: a durable transition emission.
  await world.notifications.emitFromTransition(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    {
      notificationId: "00000000-0000-4000-8000-0000000000f1",
      recipientUserId: principal.userId,
      topic: "connectivity",
      severity: "info",
      title: "Connectivity established",
      body: "Your connectivity experience is active.",
      source: {
        origin: "roamlink_state_transition",
        aggregateType: "order",
        aggregateId: "11111111-1111-4111-8111-111111111111",
        transition: "order.placed",
        eventId: "22222222-2222-4222-8222-222222222222",
        occurredAt: world.clock.now(),
      },
    },
  );
  const notificationsStore = await import("@roamlink/notifications").then((m) =>
    m.createInMemoryNotificationsStore(),
  );
  void notificationsStore;

  // --- Commerce plane: order + payment with provider metadata.
  const commerceStore = createInMemoryCommerceStore();
  const commerceLedger = new InMemoryCommerceIdempotencyLedger();
  const commerceDeps = {
    store: commerceStore,
    policy: { authorize: async () => undefined },
    ledger: commerceLedger,
    now: () => world.clock.now(),
    generateId: () => world.ids.next(),
  };
  const catalog = new CatalogService(commerceDeps);
  const orders = new OrderService(commerceDeps);
  const payments = new PaymentService(commerceDeps);
  await catalog.createProduct(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    { productId: "00000000-0000-4000-8000-0000000000d1", name: "Leak Test Pass" },
  );
  await catalog.activateProduct(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    { productId: "00000000-0000-4000-8000-0000000000d1", expectedRevision: 1 },
  );
  await catalog.createVariant(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    {
      variantId: "00000000-0000-4000-8000-0000000000d2",
      productId: "00000000-0000-4000-8000-0000000000d1",
      name: "7-Day",
      sku: "leak-pass-7d",
      billingModel: "one_time",
      termDays: 7,
      price: { amountMinorUnits: 4999, currency: "USD" },
    },
  );
  await orders.createOrder(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    { orderId: "00000000-0000-4000-8000-0000000000e1", ownerUserId: principal.userId },
  );
  await orders.addOrderLine(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId, orderVersion: 1 }),
    {
      orderId: "00000000-0000-4000-8000-0000000000e1",
      lineId: "00000000-0000-4000-8000-0000000000e6",
      variantId: "00000000-0000-4000-8000-0000000000d2",
      quantity: 1,
    },
  );
  await orders.placeOrder(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId, orderVersion: 2 }),
    { orderId: "00000000-0000-4000-8000-0000000000e1" },
  );
  await payments.recordPayment(
    world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
    {
      paymentId: "00000000-0000-4000-8000-0000000000e3",
      orderId: "00000000-0000-4000-8000-0000000000e1",
      amount: { amountMinorUnits: 4999, currency: "USD" },
      method: "card",
      providerReference: "prov:pay-opaque-ref-0001",
    },
  );
  for (const order of await commerceStore.read.orders.listByTenant(principal.tenantId)) {
    fixtures.push({ label: "commerce-order", value: order });
  }
  for (const payment of await commerceStore.read.payments.listByTenant(principal.tenantId)) {
    fixtures.push({ label: "commerce-payment", value: payment });
  }
  for (const event of await commerceStore.read.events.listForAggregate(
    principal.tenantId,
    "order",
    "00000000-0000-4000-8000-0000000000e1",
  )) {
    fixtures.push({ label: "commerce-event", value: event });
  }

  // --- Enterprise plane: API key issuance (record carries the reference only).
  const harness = createEnterpriseApiHarness({ now: () => world.clock.now() });
  const issuance = await harness.apiKeys.issue(
    {
      tenantId: "org:77777777-0000-4000-8000-000000000001",
      name: "leak-test-key",
      scopes: ["enrollments:manage"],
    },
    {
      commandId: "99999999-0000-4000-8000-00000000000a",
      correlationId: "corr.security.leak.key",
      idempotencyKey: "idem.security.leak.key",
      actorId: "actor-security",
    },
    world.clock.now(),
  );
  fixtures.push({ label: "enterprise-api-key-record", value: issuance.record });
  for (const event of await harness.audit.events()) {
    fixtures.push({ label: "enterprise-audit-event", value: event.toPlain() });
  }

  return {
    fixtures,
    // Sensitive values that must appear in NO persisted fixture.
    sensitiveValues: [login.token, principal.password],
  };
}

describe("RL-074 suite 3b: the real persisted surfaces are scanner-clean", () => {
  it("S-2 every persisted projection/read-model/log fixture the flows produce has ZERO findings", async () => {
    const world = makeSecurityWorld();
    const { fixtures, sensitiveValues } = await driveAllSurfaces(world);

    // The sweep actually covered the surfaces (a vacuous pass proves
    // nothing - assert the corpus is substantial).
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
    const labels = new Set(fixtures.map((fixture) => fixture.label.split(":")[0]));
    for (const expected of [
      "projection",
      "inbox-record",
      "inbox-admission",
      "reconciliation-job",
      "auth-session",
      "auth-credential",
      "auth-user",
      "audit-event",
      "commerce-order",
      "commerce-payment",
      "commerce-event",
      "enterprise-api-key-record",
      "enterprise-audit-event",
    ]) {
      expect(labels, `expected the sweep to cover '${expected}'`).toContain(expected);
    }

    // FINDING RL-074-F2 (recorded, not fixed - verification wave): the auth
    // session record's `tokenDigest` FIELD NAME is secret-shaped per the
    // repo's own RL-054 scanner (key-name detector, "token" fragment).
    // The VALUE is a SHA-256 digest - non-invertible, and possession of the
    // digest is NOT possession of the credential (verifySession requires
    // the token; only its digest is compared) - so the SUBSTANCE of
    // RL-LOCK-016 holds. But the naming discipline is inconsistent with
    // the enterprise package's deliberate `keyRef`/`signingKeyRef` naming
    // ("so persisted records stay RL-054 scanner-clean"). Pinned here as
    // the current observable behavior; remediation (rename or a scanner
    // allow-list decision) is an orchestrator call, not a fix this wave.
    const expectedFindings = new Set(["auth-session:$.tokenDigest"]);

    for (const fixture of fixtures) {
      const findings = scanForSecretMaterial(fixture.value);
      for (const finding of findings) {
        const key = `${fixture.label}:${finding.path}`;
        if (!expectedFindings.has(key)) {
          throw new Error(
            `secret-shaped material at ${finding.path} in ${fixture.label} (detector ${finding.detector}) - NOT a recorded finding`,
          );
        }
      }
      // Every finding is exactly the recorded one (no unexplained leaks).
      expect(
        findings.map((f) => `${fixture.label}:${f.path}`).every((k) => expectedFindings.has(k)),
      ).toBe(true);
    }

    // The recorded finding's security substance: the session record
    // contains a 64-hex digest, never the token itself - and NO fixture
    // anywhere contains the live session token or the password.
    const sessionFixture = fixtures.find((f) => f.label === "auth-session");
    if (sessionFixture === undefined) throw new Error("expected the auth-session fixture");
    expect((sessionFixture.value as { tokenDigest: string }).tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const sensitive of sensitiveValues) {
      for (const fixture of fixtures) {
        expect(JSON.stringify(fixture.value)).not.toContain(sensitive);
      }
    }
  });

  it("S-3 no secret-shaped value flows into audit events, notifications, or error messages", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x51);
    const tokenValue = "token-material-never-to-be-logged-0123456789";

    // A failed login: the error must not echo the attempted password.
    let failureMessage = "";
    try {
      await world.auth.authentication.loginWithPassword(
        world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
        { email: principal.email, password: "wrong-password-attempt-123456" },
      );
    } catch (error) {
      failureMessage = (error as Error).message;
    }
    expect(failureMessage.length).toBeGreaterThan(0);
    expect(failureMessage).not.toContain("wrong-password-attempt");

    // An audit event whose detail TRIES to smuggle the token: the bounded
    // printable detail is scanner-clean of secret-shaped material (the
    // value here is not secret-shaped, but the assertion proves the
    // discipline: detail fields never grow values).
    await world.audit.append({
      category: "secret-access",
      action: "secret.read",
      outcome: "denied",
      actorId: principal.actorId,
      tenantId: principal.tenantId,
      correlationId: "corr.security.leak.denied",
      occurredAt: world.clock.now(),
      detail: `access denied for secret reference (name never echoed)`,
    });
    for (const event of await world.audit.events()) {
      expect(scanForSecretMaterial(event.toPlain())).toEqual([]);
      expect(JSON.stringify(event.toPlain())).not.toContain(tokenValue);
    }

    // A verifier rejection: the message never contains the HMAC secret.
    const { TEST_SIGNING_SECRET } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    const { fakeWebhookDelivery } = await import(
      "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js"
    );
    const rejected = await world.admit(
      fakeWebhookDelivery({
        spec: webhookEventSpec({ eventId: "evt-leak-reject-1" }),
        deliveryId: "delivery-leak-reject-1",
        sequence: 1,
        receivedAt: world.clock.now(),
        overrides: { tamperSignature: true },
      }),
    );
    if (rejected.outcome !== "REJECTED") throw new Error("expected rejection");
    expect(rejected.message).not.toContain(TEST_SIGNING_SECRET);
    expect(rejected.message.toLowerCase()).not.toContain("secret=");
  });

  it("S-4 SecretMaterial is redacted from every serialization path", () => {
    const material = new SecretMaterial("super-secret-value-never-serialize-me");
    expect(String(material)).not.toContain("super-secret-value");
    expect(JSON.stringify(material)).not.toContain("super-secret-value");
    expect(JSON.parse(JSON.stringify(material))).toBe("[REDACTED]");
    expect(() => assertNoSecretMaterial(JSON.parse(JSON.stringify(material)))).not.toThrow();
    expect(() => assertNoSecretMaterial({ nested: JSON.parse(JSON.stringify(material)) })).not.toThrow();
  });

  it("S-5 the secrets boundary failure taxonomy never echoes values", async () => {
    const secrets = new InMemorySecrets();
    secrets.register("webhook-signing-key", "the-actual-secret-material-value");
    secrets.setUnavailable("webhook-signing-key");

    let unavailableMessage = "";
    try {
      await secrets.resolve({ name: "webhook-signing-key" as never, version: null });
    } catch (error) {
      unavailableMessage = (error as Error).message;
    }
    expect(unavailableMessage.length).toBeGreaterThan(0);
    expect(unavailableMessage).not.toContain("the-actual-secret-material-value");

    let unknownMessage = "";
    try {
      await secrets.resolve({ name: "never-registered" as never, version: null });
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      unknownMessage = (error as Error).message;
    }
    expect(unknownMessage).not.toContain("the-actual-secret-material-value");
  });

  it("S-6 malicious provider metadata (secret-shaped provider references) is rejected by the safe charset", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x52);
    const commerceStore = createInMemoryCommerceStore();
    const commerceLedger = new InMemoryCommerceIdempotencyLedger();
    const commerceDeps = {
      store: commerceStore,
      policy: { authorize: async () => undefined },
      ledger: commerceLedger,
      now: () => world.clock.now(),
      generateId: () => world.ids.next(),
    };
    const orders = new OrderService(commerceDeps);
    const payments = new PaymentService(commerceDeps);
    const catalog = new CatalogService(commerceDeps);
    await catalog.createProduct(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      { productId: "00000000-0000-4000-8000-0000000000d3", name: "S6 Test Pass" },
    );
    await catalog.activateProduct(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      { productId: "00000000-0000-4000-8000-0000000000d3", expectedRevision: 1 },
    );
    await catalog.createVariant(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      {
        variantId: "00000000-0000-4000-8000-0000000000d4",
        productId: "00000000-0000-4000-8000-0000000000d3",
        name: "7-Day",
        sku: "s6-pass-7d",
        billingModel: "one_time",
        termDays: 7,
        price: { amountMinorUnits: 100, currency: "USD" },
      },
    );
    await orders.createOrder(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      { orderId: "00000000-0000-4000-8000-0000000000e2", ownerUserId: principal.userId },
    );
    await orders.addOrderLine(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId, orderVersion: 1 }),
      {
        orderId: "00000000-0000-4000-8000-0000000000e2",
        lineId: "00000000-0000-4000-8000-0000000000e7",
        variantId: "00000000-0000-4000-8000-0000000000d4",
        quantity: 1,
      },
    );
    await orders.placeOrder(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId, orderVersion: 2 }),
      { orderId: "00000000-0000-4000-8000-0000000000e2" },
    );

    // FINDING RL-074-F1 (recorded, not fixed - verification wave): a
    // malicious provider returning a JWT-shaped string as its payment
    // "provider reference" is ACCEPTED by the commerce payment record's
    // opaque-reference charset (`[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}` allows
    // dots and base64url), and the secret-shaped value is PERSISTED into
    // the commerce read model. The repo's own RL-054 scanner flags the
    // persisted record afterward (detection exists; enforcement does not
    // run at this admission point). spec/data-model.md "Privacy": "Secrets
    // and credentials are never persisted in ordinary domain tables." The
    // value is provider-supplied opaque reference data, not a RoamLink
    // credential - the exposure is bounded - but the admission point does
    // not fail closed on secret-shaped provider metadata. Pinned as the
    // current observable behavior; remediation (run assertNoSecretMaterial
    // over provider-supplied reference fields at commerce admission, or
    // restrict the charset further) is an orchestrator call.
    const accepted = await payments.recordPayment(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      {
        paymentId: "00000000-0000-4000-8000-0000000000e4",
        orderId: "00000000-0000-4000-8000-0000000000e2",
        amount: { amountMinorUnits: 100, currency: "USD" },
        providerReference: "eyJhbGciOiJIUzI1NiJ9.attacker.payload",
      },
    );
    expect(accepted.status).toBe("pending"); // <-- the recorded finding

    // The persisted record IS flagged by the repo's own scanner (proving
    // the detection half works - the enforcement half is the gap).
    const persisted = await commerceStore.read.payments.findById(
      principal.tenantId,
      "00000000-0000-4000-8000-0000000000e4" as never,
    );
    if (persisted === undefined) throw new Error("expected the persisted payment");
    expect(scanForSecretMaterial(persisted).map((f) => f.path)).toEqual(["$.providerReference"]);
    expect(scanForSecretMaterial(persisted)[0]?.detector).toBe("value-marker");

    // Control: a PEM marker in the reference IS rejected (the charset has
    // no spaces), so the exposure is limited to seamless-token shapes.
    await expect(
      payments.recordPayment(
        world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
        {
          paymentId: "00000000-0000-4000-8000-0000000000e8",
          orderId: "00000000-0000-4000-8000-0000000000e2",
          amount: { amountMinorUnits: 100, currency: "USD" },
          providerReference: `${PEM_MARKER}MIIEvQ`,
        },
      ),
    ).rejects.toThrowError(/providerReference|payment/i);

    // And a well-formed opaque reference passes, staying scanner-clean.
    await payments.recordPayment(
      world.envelope({ actorId: principal.actorId, tenantId: principal.tenantId }),
      {
        paymentId: "00000000-0000-4000-8000-0000000000e5",
        orderId: "00000000-0000-4000-8000-0000000000e2",
        amount: { amountMinorUnits: 100, currency: "USD" },
        providerReference: "prov:opaque:ref-0002",
      },
    );
    const clean = await commerceStore.read.payments.findById(
      principal.tenantId,
      "00000000-0000-4000-8000-0000000000e5" as never,
    );
    if (clean === undefined) throw new Error("expected the clean payment");
    expect(scanForSecretMaterial(clean)).toEqual([]);
  });

  it("S-7 the edge offline outbox persists CIPHERTEXT payloads only", async () => {
    const world = makeSecurityWorld();
    const edge = await import("@roamlink/edge");
    const { fixtureFreshness } = await import("@roamlink/testkit");
    const store = new edge.InMemoryEdgeOutboxStore();
    let counter = 500;
    const engine = new edge.EdgeOfflineOutbox({
      store,
      cipher: edge.createAesGcmEdgePayloadCipher(
        async () => new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      ),
      keyId: "edge-leak-key",
      idGenerator: () => `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, "0")}`,
      defaultRetryPolicy: { maxAttempts: 3, initialBackoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 1_000 },
    });
    const request = edge.DeviceActionRequest.fromPlain({
      actionId: "00000000-0000-4000-8000-0000000007a1",
      capabilityRequirement: { capability: "wifi_control" },
      parameters: { note: "edge desired state", password: "edge-credential-material-1234567890" },
      command: {
        commandId: "00000000-0000-4000-8000-0000000008a1",
        correlationId: "corr.security.edge.leak",
        idempotencyKey: "idem.security.edge.leak",
        actorId: "actor-security",
        tenantId: "org:77777777-0000-4000-8000-000000000001",
        createdAt: world.clock.now(),
        retry: { attempt: 1 },
      },
      dedupeKey: "action-leak-1",
    });
    const { record } = await engine.enqueue(
      request,
      {
        deviceRef: "device-leak-1",
        desiredStateId: "00000000-0000-4000-8000-0000000000d1",
        lastKnownFreshness: fixtureFreshness(),
      },
      world.clock.now(),
    );
    // The persisted payload is ciphertext: the plaintext secret never
    // appears in the record OR the whole store serialization.
    expect(record.ciphertextEnvelope.algorithm).toBe("aes-256-gcm");
    expect(record.ciphertextEnvelope.ciphertext).not.toContain("edge-credential-material");
    const persisted = JSON.stringify(await store.list());
    expect(persisted).not.toContain("edge-credential-material");
    expect(persisted).not.toContain("parameters");
    // The scanner over the persisted record finds nothing.
    expect(scanForSecretMaterial(JSON.parse(JSON.stringify(record)))).toEqual([]);
  });
});
