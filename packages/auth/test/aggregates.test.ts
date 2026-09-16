/**
 * RL-004 aggregate + primitive unit tests: actor principals, contact
 * primitives, User / Organization / Membership aggregates, the frozen
 * permission map, the password-hashing port and opaque tokens.
 */
import { describe, expect, it } from "vitest";

import { ValidationError, parseUtcInstant } from "@roamlink/contracts";

import {
  ACCOUNT_PERMISSIONS,
  InsecureTestPasswordHasher,
  Membership,
  Organization,
  User,
  actorIdForService,
  actorIdForUser,
  generateAuthToken,
  isAuthToken,
  parseAccountPermission,
  parseActorPrincipal,
  parseAuthToken,
  parseEmailAddress,
  parsePasswordHash,
  parsePasswordSecret,
  parseSafeLabel,
  permissionsForRole,
  roleHasPermission,
  tokenDigestOf,
} from "../src/index.js";

import { T0 } from "./helpers.js";

const at = (iso: string) => parseUtcInstant(iso);

describe("actor principals (ids.ts)", () => {
  it("parses usr: principals into user principals", () => {
    const actorId = actorIdForUser("00000000-0000-4000-8000-000000000001");
    const principal = parseActorPrincipal(actorId);
    expect(principal).toEqual({
      kind: "user",
      userId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("parses svc: principals into service principals", () => {
    expect(parseActorPrincipal(actorIdForService("edge-sync"))).toEqual({
      kind: "service",
      label: "edge-sync",
    });
  });

  it("rejects malformed principals fail-closed without echoing the value", () => {
    for (const bad of ["", "usr:", "usr:not-a-uuid", "svc:", "svc:UPPER", "svc:bad_label", "other:x", 42]) {
      expect(() => parseActorPrincipal(bad)).toThrowError(ValidationError);
    }
    // Values that are not part of the documented grammar must never be echoed.
    for (const bad of ["usr:not-a-uuid", "svc:bad_label", "other:x"]) {
      try {
        parseActorPrincipal(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(bad);
      }
    }
  });
});

describe("contact primitives (contact.ts)", () => {
  it("accepts well-formed emails and rejects malformed ones without echoing", () => {
    expect(parseEmailAddress("user@example.com")).toBe("user@example.com");
    expect(parseEmailAddress("first.last+tag@sub.example.co")).toBe("first.last+tag@sub.example.co");
    for (const bad of ["", "no-at", "@example.com", "user@", "a b@example.com", "x".repeat(300)]) {
      expect(() => parseEmailAddress(bad)).toThrowError(ValidationError);
    }
    try {
      parseEmailAddress("secret-value@example.com");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
  });

  it("safe labels are bounded and reject control characters", () => {
    expect(parseSafeLabel("Acahat Co", "label")).toBe("Acahat Co");
    expect(() => parseSafeLabel("   ", "label")).toThrowError(ValidationError);
    expect(() => parseSafeLabel("x".repeat(65), "label")).toThrowError(ValidationError);
    expect(() => parseSafeLabel("bad\u0007label", "label")).toThrowError(ValidationError);
    expect(() => parseSafeLabel(42 as unknown as string, "label")).toThrowError(ValidationError);
  });
});

describe("User aggregate", () => {
  const base = {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "u@example.com",
    displayName: "User One",
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  };

  it("constructs, freezes and derives the personal tenant", () => {
    const user = new User(base);
    expect(Object.isFrozen(user)).toBe(true);
    expect(user.tenantId).toBe("usr:00000000-0000-4000-8000-000000000001");
    expect(user.revision).toBe(1);
  });

  it("suspend/reactivate are validated transitions with a revision bump", () => {
    const user = new User(base);
    const suspended = user.suspend(at("2026-01-15T09:00:00.000Z"));
    expect(suspended.status).toBe("suspended");
    expect(suspended.revision).toBe(2);
    expect(user.status).toBe("active"); // original untouched
    expect(() => suspended.suspend(at("2026-01-15T09:01:00.000Z"))).toThrowError(ValidationError);
    const reactivated = suspended.reactivate(at("2026-01-15T09:02:00.000Z"));
    expect(reactivated.status).toBe("active");
    expect(reactivated.revision).toBe(3);
  });

  it("rejects unknown fields and bad shapes (fail-closed)", () => {
    expect(() => new User({ ...base, extra: "no" } as never)).toThrowError(/unknown field/);
    expect(() => new User({ ...base, userId: "not-a-uuid" })).toThrowError(ValidationError);
    expect(() => new User({ ...base, status: "banned" })).toThrowError(ValidationError);
    expect(() => new User({ ...base, revision: 0 })).toThrowError(ValidationError);
  });
});

describe("Organization aggregate", () => {
  const base = {
    organizationId: "00000000-0000-4000-8000-000000000002",
    name: "Acahat",
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  };

  it("derives the org tenant and freezes", () => {
    const org = new Organization(base);
    expect(Object.isFrozen(org)).toBe(true);
    expect(org.tenantId).toBe("org:00000000-0000-4000-8000-000000000002");
  });

  it("suspend/activate are validated with revision bumps", () => {
    const org = new Organization(base);
    const suspended = org.suspend(at("2026-01-15T09:00:00.000Z"));
    expect(suspended.status).toBe("suspended");
    expect(suspended.revision).toBe(2);
    expect(() => suspended.suspend(at("2026-01-15T09:00:01.000Z"))).toThrowError(ValidationError);
    expect(suspended.activate(at("2026-01-15T09:01:00.000Z")).status).toBe("active");
  });
});

describe("Membership aggregate + frozen permission map", () => {
  const base = {
    membershipId: "00000000-0000-4000-8000-000000000003",
    organizationId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000001",
    role: "member",
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
  };

  it("role changes and revocation are validated; revocation is terminal", () => {
    const m = new Membership(base);
    const admin = m.changeRole("admin", at("2026-01-15T09:00:00.000Z"));
    expect(admin.role).toBe("admin");
    expect(admin.revision).toBe(2);
    expect(() => admin.changeRole("admin", at("2026-01-15T09:00:01.000Z"))).toThrowError(ValidationError);
    const revoked = admin.revoke(at("2026-01-15T09:01:00.000Z"));
    expect(revoked.status).toBe("revoked");
    expect(() => revoked.revoke(at("2026-01-15T09:02:00.000Z"))).toThrowError(ValidationError);
    expect(() => revoked.changeRole("member", at("2026-01-15T09:03:00.000Z"))).toThrowError(ValidationError);
  });

  it("the permission vocabulary is closed and parsers reject outsiders", () => {
    expect(ACCOUNT_PERMISSIONS).toHaveLength(8);
    expect(parseAccountPermission("org:manage")).toBe("org:manage");
    expect(() => parseAccountPermission("org:delete")).toThrowError(ValidationError);
  });

  it("the role permission map is frozen: owner > admin > member", () => {
    expect(permissionsForRole("owner")).toHaveLength(8);
    for (const permission of ACCOUNT_PERMISSIONS) {
      expect(roleHasPermission("owner", permission)).toBe(true);
    }
    expect(roleHasPermission("admin", "owner:manage")).toBe(false);
    expect(roleHasPermission("admin", "member:invite")).toBe(true);
    expect(roleHasPermission("member", "member:invite")).toBe(false);
    expect(roleHasPermission("member", "org:read")).toBe(true);
  });
});

describe("password hashing port", () => {
  it("the insecure test double hashes and verifies deterministically", async () => {
    const hasher = new InsecureTestPasswordHasher();
    const secret = parsePasswordSecret("correct-horse-battery");
    const hash = await hasher.hash(secret);
    expect(hash.algorithm).toBe("insecure-test-sha256");
    expect(await hasher.verify(secret, hash)).toBe(true);
    expect(await hasher.verify(parsePasswordSecret("wrong-horse-battery"), hash)).toBe(false);
  });

  it("verification fails closed on foreign algorithm labels", async () => {
    const hasher = new InsecureTestPasswordHasher();
    expect(
      await hasher.verify(parsePasswordSecret("correct-horse-battery"), {
        algorithm: "scrypt",
        digest: "00",
      }),
    ).toBe(false);
  });

  it("secrets are length-bounded and hash records carry exactly two fields", () => {
    expect(() => parsePasswordSecret("short")).toThrowError(ValidationError);
    expect(() => parsePasswordSecret("x".repeat(257))).toThrowError(ValidationError);
    expect(() => parsePasswordHash({ algorithm: "scrypt" })).toThrowError(ValidationError);
    expect(() => parsePasswordHash({ algorithm: "scrypt", digest: "d", extra: 1 })).toThrowError(
      ValidationError,
    );
  });
});

describe("opaque tokens", () => {
  it("tokens are rlt_ + 43 base64url chars and never collide in practice", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const token = generateAuthToken();
      expect(isAuthToken(token)).toBe(true);
      tokens.add(token);
    }
    expect(tokens.size).toBe(64);
  });

  it("digests are deterministic and never contain the token", () => {
    const token = generateAuthToken();
    const digest = tokenDigestOf(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenDigestOf(token)).toBe(digest);
    expect(digest).not.toContain(token);
  });

  it("parsing rejects malformed tokens without echoing them", () => {
    for (const bad of ["", "rlt_", "slk_abc", `rlt_${"a".repeat(42)}`, 42]) {
      expect(() => parseAuthToken(bad)).toThrowError(ValidationError);
    }
    for (const bad of ["slk_abc", `rlt_${"a".repeat(42)}`]) {
      try {
        parseAuthToken(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(bad);
      }
    }
  });
});
