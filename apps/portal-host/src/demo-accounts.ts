/**
 * The public demo accounts (quick action logins) for the demo deployment
 * (spec/deployment.md §6 "demo": the public, non-commercial environment).
 *
 * GATED by ROAMLINK_DEMO_ACCOUNTS in the composition (parseDemoAccountsGate):
 * unset/empty, "0" or "false" -> NO demo accounts exist anywhere (the default,
 * fail-closed); "1" or "true" -> the roster below is seeded through the REAL
 * @roamlink/auth administration boundary at composition time and the login
 * document renders one-click sign-in forms for each persona.
 *
 * Design laws this module obeys:
 *  - the personas are PUBLIC FIXTURES of the demo environment, not secrets:
 *    the shared password is rendered on the login page next to the buttons
 *    (RL-LOCK-016 governs secret material; a displayed demo password is not
 *    secret material by definition). Real user accounts are unaffected.
 *  - every identity is DETERMINISTIC (fixed UUIDs, fixed idempotency keys,
 *    fixed envelope createdAt): a re-seed over the same stores replays to the
 *    same recorded outcomes (RL-LOCK-014), and a fresh process rebuilds the
 *    identical roster - tenant ownership never drifts between boots.
 *  - seeding runs ONLY through the real account administration use cases
 *    (registerUser / createOrganization / addMember) over the composition's
 *    identity stores - never a direct repository write, never an invented
 *    membership state.
 */
import {
  CommandEnvelope,
  ConflictError,
  parseOrganizationId,
  parseUserId,
  parseUtcInstant,
  tenantIdFromOrganization,
  tenantIdFromUser,
  type UtcInstant,
} from "@roamlink/contracts";
import {
  AccountAdministrationService,
  AuthorizationService,
  type CredentialRepository,
  type IdempotencyLedger,
  type MembershipRepository,
  type OrganizationRepository,
  type PasswordHasher,
  type UserDirectory,
  type UserRepository,
} from "@roamlink/auth";

/**
 * The fixed allocation table. Every id is a canonical lowercase UUID chosen
 * once; changing any of them changes the demo identities (a NEW account would
 * be seeded beside the old one on stores that survive, so treat this table as
 * frozen until identity persistence lands and a migration story exists).
 */
const DEMO_IDS = Object.freeze({
  users: Object.freeze({
    customer: parseUserId("9ca608db-88a2-45b1-a5c3-948c1fcbb7ae"),
    owner: parseUserId("b1024102-3779-4ede-a25a-4a4ac4b79644"),
    member: parseUserId("bfe7b17b-4d7c-4e78-80ee-32d5d3512852"),
  }),
  organization: parseOrganizationId("2dc7f531-6317-4246-9be0-8a1793ad2bf3"),
  memberships: Object.freeze({
    owner: "519c0278-7408-4666-9c86-34eddb42ff15",
    member: "69a3b249-4d2f-4dd4-b4b4-9799d4a04937",
  }),
  commands: Object.freeze({
    registerCustomer: "5af6d420-9ef6-4626-b8aa-af63f678b757",
    registerOwner: "8f34c443-1f0f-439f-9a96-4f8d6c69d3f1",
    registerMember: "c67d1ead-a93f-4282-8654-828767abeb4f",
    createOrganization: "4bdf3f48-820a-497e-af13-1fc4132ecb9e",
    addMember: "ea98aba6-9ae6-4003-bd35-1e4f1ab868ea",
  }),
});

/**
 * The demo seed envelopes' fixed mint instant: a CONSTANT so the canonical
 * envelope digest (which covers createdAt) is stable and a re-seed replays
 * instead of conflicting on the same idempotency keys.
 */
const DEMO_SEED_ENVELOPE_AT: UtcInstant = parseUtcInstant("2026-01-15T00:00:00.000Z");

/** The shared, PUBLIC demo password (rendered on the login page). */
export const DEMO_ACCOUNT_PASSWORD = "roamlink-demo";

/** The demo organization every org-scoped persona belongs to. */
export const DEMO_ORGANIZATION_NAME = "RoamLink Demo Cooperative";

/** The stable persona marker (login document + tests key on this). */
export type DemoAccountKey = "customer" | "owner" | "member";

/** One demo persona as the login document renders it (public by design). */
export interface DemoAccountView {
  readonly key: DemoAccountKey;
  readonly email: string;
  readonly displayName: string;
  readonly summary: string;
  readonly password: string;
}

/** The public demo roster (frozen; emails use the reserved .example domain). */
export const DEMO_ACCOUNTS: readonly DemoAccountView[] = Object.freeze([
  Object.freeze({
    key: "customer",
    email: "customer@demo.roamlink.example",
    displayName: "Demo Customer",
    summary:
      "A personal-tenant customer account: the standard RoamLink web experience (home, connectivity, devices, goals, plans, support).",
    password: DEMO_ACCOUNT_PASSWORD,
  }),
  Object.freeze({
    key: "owner",
    email: "owner@demo.roamlink.example",
    displayName: "Demo Org Owner",
    summary: `Owns the ${DEMO_ORGANIZATION_NAME} organization (owner role): the enterprise workspace journey with the full account permission set.`,
    password: DEMO_ACCOUNT_PASSWORD,
  }),
  Object.freeze({
    key: "member",
    email: "member@demo.roamlink.example",
    displayName: "Demo Org Member",
    summary: `A member of the ${DEMO_ORGANIZATION_NAME} organization (member role): org-scoped reads without management permissions.`,
    password: DEMO_ACCOUNT_PASSWORD,
  }),
]);

/** The identity stores the seed needs (structural: the composition satisfies it). */
export interface DemoAccountSeedDeps {
  readonly users: UserRepository;
  readonly directory: UserDirectory;
  readonly credentials: CredentialRepository;
  readonly organizations: OrganizationRepository;
  readonly memberships: MembershipRepository;
  readonly ledger: IdempotencyLedger;
  readonly hasher: PasswordHasher;
  readonly now: () => UtcInstant;
}

/** Conflict reasons that mean "this fixture already exists" (idempotent pass). */
const ALREADY_SEEDED_REASONS: ReadonlySet<string> = new Set([
  "USER_ALREADY_EXISTS",
  "EMAIL_ALREADY_REGISTERED",
  "ORGANIZATION_ALREADY_EXISTS",
  "MEMBER_ALREADY_ACTIVE",
]);

function alreadySeeded(error: unknown): boolean {
  return error instanceof ConflictError && ALREADY_SEEDED_REASONS.has(error.reason);
}

/**
 * Builds the administration service with one PINNED membership id (the id the
 * next actual create must record - deterministic per seeding step, never a
 * random value, so the roster is identical on every boot).
 */
function administrationWithMembershipId(
  deps: DemoAccountSeedDeps,
  membershipId: string,
): AccountAdministrationService {
  return new AccountAdministrationService({
    users: deps.users,
    directory: deps.directory,
    credentials: deps.credentials,
    organizations: deps.organizations,
    memberships: deps.memberships,
    ledger: deps.ledger,
    hasher: deps.hasher,
    authorization: new AuthorizationService(deps.memberships, deps.organizations),
    now: deps.now,
    generateMembershipId: () => membershipId,
  });
}

/** One deterministic seed envelope (fixed command id, key and mint instant). */
function demoEnvelope(input: {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly tenantId: string;
}): CommandEnvelope {
  return new CommandEnvelope({
    commandId: input.commandId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    tenantId: input.tenantId,
    createdAt: DEMO_SEED_ENVELOPE_AT,
    retry: { attempt: 1 },
  });
}

async function registerDemoUser(
  deps: DemoAccountSeedDeps,
  account: DemoAccountView,
  userId: string,
  commandId: string,
): Promise<void> {
  try {
    await administrationWithMembershipId(deps, "unused-by-register-user").registerUser(
      demoEnvelope({
        commandId,
        correlationId: `demo-seed-${account.key}`,
        idempotencyKey: `demo-seed-register-${account.key}`,
        actorId: `usr:${userId}`,
        tenantId: tenantIdFromUser(parseUserId(userId)),
      }),
      {
        userId,
        email: account.email,
        displayName: account.displayName,
        password: account.password,
      },
    );
  } catch (error) {
    if (!alreadySeeded(error)) throw error;
  }
}

/**
 * Seeds the demo roster through the REAL account administration use cases:
 * three users, one organization (owned by the owner persona) and the owner +
 * member memberships. Deterministic envelopes make a re-seed over the same
 * stores an idempotent replay; "already exists" conflicts (stores that
 * outlived their ledger) are tolerated as the same fixed fixtures.
 *
 * Returns the public roster for the login document.
 */
export async function seedDemoAccounts(
  deps: DemoAccountSeedDeps,
): Promise<readonly DemoAccountView[]> {
  const [customer, owner, member] = DEMO_ACCOUNTS;
  if (customer === undefined || owner === undefined || member === undefined) {
    throw new Error("the demo roster is malformed (expected exactly the three fixed personas)");
  }

  await registerDemoUser(deps, customer, DEMO_IDS.users.customer, DEMO_IDS.commands.registerCustomer);
  await registerDemoUser(deps, owner, DEMO_IDS.users.owner, DEMO_IDS.commands.registerOwner);
  await registerDemoUser(deps, member, DEMO_IDS.users.member, DEMO_IDS.commands.registerMember);

  // The organization, created BY the owner persona in the organization's own
  // tenant (the administration service's own owner-validity checks apply).
  const orgTenantId = tenantIdFromOrganization(DEMO_IDS.organization);
  try {
    await administrationWithMembershipId(deps, DEMO_IDS.memberships.owner).createOrganization(
      demoEnvelope({
        commandId: DEMO_IDS.commands.createOrganization,
        correlationId: "demo-seed-organization",
        idempotencyKey: "demo-seed-create-organization",
        actorId: `usr:${DEMO_IDS.users.owner}`,
        tenantId: orgTenantId,
      }),
      { organizationId: DEMO_IDS.organization, name: DEMO_ORGANIZATION_NAME },
    );
  } catch (error) {
    if (!alreadySeeded(error)) throw error;
  }

  // The member persona joins as "member" (the owner authorizes the invite).
  try {
    await administrationWithMembershipId(deps, DEMO_IDS.memberships.member).addMember(
      demoEnvelope({
        commandId: DEMO_IDS.commands.addMember,
        correlationId: "demo-seed-membership",
        idempotencyKey: "demo-seed-add-member",
        actorId: `usr:${DEMO_IDS.users.owner}`,
        tenantId: orgTenantId,
      }),
      { organizationId: DEMO_IDS.organization, userId: DEMO_IDS.users.member, role: "member" },
    );
  } catch (error) {
    if (!alreadySeeded(error)) throw error;
  }

  return DEMO_ACCOUNTS;
}
