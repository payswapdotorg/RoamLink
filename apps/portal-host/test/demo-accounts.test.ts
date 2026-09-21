/**
 * The demo accounts (quick action logins): the fail-closed gate, the
 * deterministic seed through the REAL @roamlink/auth administration boundary,
 * the login document's quick action forms, and the full quick-login round
 * trip through the host session layer (the same cookie binding the manual
 * form uses - there is deliberately NO parallel auth path).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseOrganizationId,
  parseUserId,
  tenantIdFromUser,
  tenantIdFromOrganization,
  type UtcInstant,
} from "@roamlink/contracts";
import { parseEmailAddress } from "@roamlink/auth";
import {
  createPostgresMigrationRunner,
  setMigrationFileAccess,
  setMigrationPathResolver,
} from "@roamlink/persistence-postgres";

import {
  CompositionError,
  createPortalHostComposition,
  handleLoginPage,
  handleLoginSubmit,
  handleV1,
  parseDemoAccountsGate,
  seedDemoAccounts,
  DEMO_ACCOUNTS,
  DEMO_ACCOUNT_PASSWORD,
  DEMO_ORGANIZATION_NAME,
  type PortalHostComposition,
} from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const T0: UtcInstant = "2026-01-15T08:30:00.000Z" as UtcInstant;

/** The frozen allocation table (demo-accounts.ts): asserted verbatim so a
 *  silent change to the demo identities is a visible test failure. */
const FIXED_IDS = Object.freeze({
  users: Object.freeze({
    customer: parseUserId("9ca608db-88a2-45b1-a5c3-948c1fcbb7ae"),
    owner: parseUserId("b1024102-3779-4ede-a25a-4a4ac4b79644"),
    member: parseUserId("bfe7b17b-4d7c-4e78-80ee-32d5d3512852"),
  }),
  organization: parseOrganizationId("2dc7f531-6317-4246-9be0-8a1793ad2bf3"),
});

function pinRealMigrations(): void {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => join(REPO_ROOT, "infra", "migrations"));
}

/** Boots one host composition (optionally demo-enabled, optionally migrated). */
async function createHost(options?: {
  readonly demo?: boolean;
  readonly migrated?: boolean;
}): Promise<PortalHostComposition> {
  pinRealMigrations();
  const composition = await createPortalHostComposition({
    mode: "development",
    databaseUrl: "pglite://",
    ...(options?.demo ? { demoAccounts: "1" } : {}),
    now: () => T0,
  });
  if (options?.migrated) {
    const applied = await createPostgresMigrationRunner({ driver: composition.driver }).migrateUp();
    expect(applied.length).toBeGreaterThanOrEqual(4);
  }
  return composition;
}

function runtimeOf(composition: PortalHostComposition) {
  return { ok: true as const, composition };
}

/** Posts the login form exactly the quick action button submits it. */
async function quickLoginAs(composition: PortalHostComposition, email: string) {
  const form = new FormData();
  form.set("email", email);
  form.set("password", DEMO_ACCOUNT_PASSWORD);
  return handleLoginSubmit(
    new Request("https://host.example/auth/session", { method: "POST", body: form }),
    runtimeOf(composition),
  );
}

function sessionCookieValueOf(setCookie: string | null): string {
  expect(setCookie).toContain("roamlink_session=");
  expect(setCookie).toContain("HttpOnly");
  const token = setCookie?.split(";")[0]?.split("=")[1] ?? "";
  expect(token.length).toBeGreaterThan(0);
  return token;
}

describe("parseDemoAccountsGate (fail-closed configuration)", () => {
  it("treats unset/empty as DISABLED (no demo surface anywhere)", () => {
    expect(parseDemoAccountsGate(undefined)).toBe(false);
    expect(parseDemoAccountsGate("")).toBe(false);
    expect(parseDemoAccountsGate("   ")).toBe(false);
  });

  it("enables on exactly 1/true (case-insensitive) and disables on 0/false", () => {
    expect(parseDemoAccountsGate("1")).toBe(true);
    expect(parseDemoAccountsGate("true")).toBe(true);
    expect(parseDemoAccountsGate("TRUE")).toBe(true);
    expect(parseDemoAccountsGate(" True ")).toBe(true);
    expect(parseDemoAccountsGate("0")).toBe(false);
    expect(parseDemoAccountsGate("false")).toBe(false);
    expect(parseDemoAccountsGate("FALSE")).toBe(false);
  });

  it("REFUSES any ambiguous value (never a silent interpretation)", () => {
    for (const raw of ["yes", "on", "enabled", "demo", "2"]) {
      expect(() => parseDemoAccountsGate(raw)).toThrow(CompositionError);
    }
    try {
      parseDemoAccountsGate("yes");
      expect.unreachable("the gate must refuse the ambiguous value");
    } catch (error) {
      expect(error instanceof CompositionError).toBe(true);
      expect((error as CompositionError).message).toContain("ROAMLINK_DEMO_ACCOUNTS");
    }
  });
});

describe("the composition gate wiring", () => {
  it("seeds NOTHING by default and the login document carries no demo surface", async () => {
    const composition = await createHost();
    try {
      expect(composition.demo.accounts).toEqual([]);
      const page = handleLoginPage(runtimeOf(composition));
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).not.toContain("data-demo-accounts");
      expect(html).toContain('action="/auth/session"');
    } finally {
      await composition.dispose();
    }
  });

  it("seeds the public roster when enabled and renders the quick action forms", async () => {
    const composition = await createHost({ demo: true });
    try {
      expect(composition.demo.accounts.map((a) => a.key)).toEqual(["customer", "owner", "member"]);
      const page = handleLoginPage(runtimeOf(composition));
      const html = await page.text();
      expect(html).toContain('data-demo-accounts="true"');
      expect(html).toContain('data-demo-account="customer"');
      expect(html).toContain('data-demo-account="owner"');
      expect(html).toContain('data-demo-account="member"');
      // The quick action forms POST the persona's public credentials to the
      // SAME cookie-binding route the manual form uses.
      expect(html).toContain('action="/auth/session"');
      expect(html).toContain(`value="customer@demo.roamlink.example"`);
      expect(html).toContain(`value="${DEMO_ACCOUNT_PASSWORD}"`);
      expect(html).toContain("Demo Customer");
      // The manual credential form stays (the divider only appears with demo).
      expect(html).toContain("or sign in with credentials");
    } finally {
      await composition.dispose();
    }
  });

  it("refuses to boot on an ambiguous gate value (fail-closed)", async () => {
    await expect(
      createPortalHostComposition({
        mode: "development",
        databaseUrl: "pglite://",
        demoAccounts: "yes",
        now: () => T0,
      }),
    ).rejects.toThrow(/ROAMLINK_DEMO_ACCOUNTS/);
  });
});

describe("the deterministic seed (REAL auth services, frozen identities)", () => {
  it("registers the three personas under their FIXED user ids", async () => {
    const composition = await createHost({ demo: true });
    try {
      const { identity } = composition;
      const customer = await identity.directory.resolveUserIdByEmail(
        parseEmailAddress("customer@demo.roamlink.example"),
      );
      const owner = await identity.directory.resolveUserIdByEmail(
        parseEmailAddress("owner@demo.roamlink.example"),
      );
      const member = await identity.directory.resolveUserIdByEmail(
        parseEmailAddress("member@demo.roamlink.example"),
      );
      expect(customer).toBe(FIXED_IDS.users.customer);
      expect(owner).toBe(FIXED_IDS.users.owner);
      expect(member).toBe(FIXED_IDS.users.member);
    } finally {
      await composition.dispose();
    }
  });

  it("creates the demo organization with the owner + member memberships", async () => {
    const composition = await createHost({ demo: true });
    try {
      const orgTenant = tenantIdFromOrganization(FIXED_IDS.organization);
      const organization = await composition.identity.organizations.findById(
        orgTenant,
        FIXED_IDS.organization,
      );
      expect(organization?.name).toBe(DEMO_ORGANIZATION_NAME);
      expect(organization?.status).toBe("active");

      const memberships = await composition.identity.memberships.listByOrganization(
        orgTenant,
        FIXED_IDS.organization,
      );
      const active = memberships.filter((m) => m.status === "active");
      expect(active).toHaveLength(2);
      const ownerMembership = active.find((m) => m.userId === FIXED_IDS.users.owner);
      const memberMembership = active.find((m) => m.userId === FIXED_IDS.users.member);
      expect(ownerMembership?.role).toBe("owner");
      expect(memberMembership?.role).toBe("member");
    } finally {
      await composition.dispose();
    }
  });

  it("re-seeding over the same stores is an idempotent replay (no duplicates, no throw)", async () => {
    const composition = await createHost();
    try {
      const accounts = await seedDemoAccounts({ ...composition.identity, now: () => T0 });
      expect(accounts).toHaveLength(3);
      // The second seed over the SAME stores replays the deterministic
      // envelopes (same digests) - the recorded outcomes return verbatim.
      const again = await seedDemoAccounts({ ...composition.identity, now: () => T0 });
      expect(again.map((a) => a.key)).toEqual(["customer", "owner", "member"]);

      const orgTenant = tenantIdFromOrganization(FIXED_IDS.organization);
      const memberships = await composition.identity.memberships.listByOrganization(
        orgTenant,
        FIXED_IDS.organization,
      );
      expect(memberships.filter((m) => m.status === "active")).toHaveLength(2);
    } finally {
      await composition.dispose();
    }
  });
});

describe("the quick action logins (the full host session round trip)", () => {
  it("signs in every persona through the same cookie binding as the manual form", async () => {
    const composition = await createHost({ demo: true, migrated: true });
    try {
      for (const account of DEMO_ACCOUNTS) {
        const login = await quickLoginAs(composition, account.email);
        expect(login.status).toBe(303);
        expect(login.headers.get("location")).toBe("/");
        const token = sessionCookieValueOf(login.headers.get("set-cookie"));

        // The principal view through the /v1 mount with the presented token.
        const me = await handleV1(
          new Request("https://host.example/v1/users/me", {
            headers: { authorization: `Bearer ${token}` },
          }),
          runtimeOf(composition),
        );
        expect(me.status).toBe(200);
        const principal = (await me.json()) as Record<string, unknown>;
        const expectedUserId =
          account.key === "customer"
            ? FIXED_IDS.users.customer
            : account.key === "owner"
              ? FIXED_IDS.users.owner
              : FIXED_IDS.users.member;
        expect(principal["actorId"]).toBe(`usr:${expectedUserId}`);
        expect(principal["tenantId"]).toBe(tenantIdFromUser(expectedUserId));
      }
    } finally {
      await composition.dispose();
    }
  });

  it("rejects a wrong password for a demo account with the typed failure (no oracle beyond it)", async () => {
    const composition = await createHost({ demo: true, migrated: true });
    try {
      const form = new FormData();
      form.set("email", "customer@demo.roamlink.example");
      form.set("password", "not-the-demo-password");
      const response = await handleLoginSubmit(
        new Request("https://host.example/auth/session", { method: "POST", body: form }),
        runtimeOf(composition),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("authentication failed");
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      await composition.dispose();
    }
  });

  it("serves the login document without the demo surface when the composition refused", () => {
    const page = handleLoginPage({
      ok: false,
      error: new CompositionError("DATABASE_URL is not configured"),
    });
    expect(page.status).toBe(200);
    return page.text().then((html) => {
      expect(html).not.toContain("data-demo-accounts");
      expect(html).toContain('action="/auth/session"');
    });
  });
});
