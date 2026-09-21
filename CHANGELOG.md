# Changelog

All notable changes to the RoamLink repository are documented here. The
format follows Keep-a-Changelog; the project version is tracked in the
repository tags.

## [Unreleased] — Demo environment public accounts (quick action logins)

### Added

- **`ROAMLINK_DEMO_ACCOUNTS` gate + public demo roster
  (`apps/portal-host/src/demo-accounts.ts`):** the demo environment's
  public sign-in fixtures, disabled everywhere by default. `"1"`/`"true"`
  (case-insensitive) seeds three personas — Demo Customer (personal
  tenant), Demo Org Owner and Demo Org Member (the `RoamLink Demo
  Cooperative` organization with owner/member memberships) — through the
  REAL `@roamlink/auth` administration boundary (registerUser /
  createOrganization / addMember; never a direct repository write) at
  composition time. Every identity is deterministic (fixed UUIDs, fixed
  idempotency keys, fixed envelope mint instant), so a re-seed over the
  same stores is an idempotent replay and every cold boot rebuilds the
  identical roster. Unset/`"0"`/`"false"` seeds nothing; any other value
  REFUSES the host boot (fail-closed gate parsing,
  `parseDemoAccountsGate`). The personas are public fixtures, not
  secrets: emails use the reserved `.example` domain and the shared
  password is rendered on the login page by design (RL-LOCK-016 governs
  secret material; a displayed demo password is not secret material).
- **Quick action logins on the host login document:** when the roster is
  seeded, `/login` renders one-click sign-in forms (one per persona) that
  POST the persona's public credentials to the SAME `/auth/session`
  cookie binding the manual form uses — no parallel auth path, no
  client-side script, the manual credential form stays. The composition
  exposes the read-only roster view at `composition.demo.accounts`;
  `handleLoginPage` renders the section only for a booted, demo-enabled
  composition (a refused composition still serves the plain form).
- **Test battery (`apps/portal-host/test/demo-accounts.test.ts`):** the
  fail-closed gate table, the frozen identity allocation asserted
  verbatim, the organization/membership wiring, the idempotent re-seed,
  the full quick-login round trip per persona (form POST → httpOnly
  cookie → `/v1/users/me` principal view) and the typed wrong-password
  rejection.

## [Unreleased] — Post-gate productization, Wave 6 (Worker A)

### Added (RL-082, RL-083)

- **Customer application shell (RL-083):** app-kit `ui/shell.ts` — the
  application-shell layout with persistent connectivity status (derived
  only from the authoritative read model, facts shown, honest
  `unverifiable` on read failure), desktop sidebar + mobile bottom
  navigation, aria-current/skip-link/focus-visible/reduced-motion/
  touch-target a11y rules, and the warm-light quiet visual system
  (ADR-0002; the shell is a presentation boundary with zero authority).
- **Exact customer navigation:** desktop Home | Connectivity | Activity |
  Devices | Goals | Plans & Billing | Support; mobile Home | Connect |
  Activity | Devices | More (More sheet: Goals, Plans & Billing, Support,
  Settings). Routes stay stable; labels are human.
- **Home hero (`/`):** answers am I usefully connected / current goal /
  is RoamLink managing anything / does it need me — within one viewport,
  state families separate, evidence + freshness visible.
- **First-run onboarding (RL-082):** four lightweight steps (welcome, goal,
  device, confirm) with the spec's goal language mapped onto typed
  ExperienceIntent access classes; stateless-by-construction wizard; the
  `completeOnboardingFlow` create+activate command pair through the full
  envelope; vocabulary-ban test enforces the novice-path rule.
- **Human-language vocabulary + Activity/More/Settings surfaces** for the
  shell destinations (activity narrative over the durable notifications,
  which keep their dedicated route).

## [0.1.0-mvp] — MVP release candidate (RL-080/RL-081 gate wave)

Drafted by the RL-080/RL-081 release-gate worker as the MVP release notes.
Merge state: everything below is on `main` as of the release-gate branch
point; the MVP release gate verdict for this tree is recorded in
`docs/reports/mvp-release-gate.md` (with the production-readiness verdict in
`docs/reports/production-readiness-gate.md`).

### Added — the Connectivity Experience OS on ADCOS (waves 1–5)

- **Foundation (RL-001..004):** pnpm 10 / Node 22 TypeScript monorepo with
  ESLint/typecheck/vitest per package, CI, git hooks, the frozen
  architecture sanity script; `@roamlink/contracts` (opaque IDs, UTC
  instants, evidence classes, error taxonomy, the §5 command envelope,
  versioning, canonical JSON + SHA-256 digests, env schema);
  `@roamlink/persistence` (migrations runner, UnitOfWork, transactional
  outbox, optimistic concurrency); `@roamlink/auth` (users, organizations,
  memberships, server-side sessions, fail-closed tenant boundary).
- **Experience (RL-010..014):** device registry with evidence-tagged
  capability/context snapshots; immutable versioned `ExperienceIntent`;
  the deterministic intent compiler to ADCOS ConnectivityIntent commands
  (RL-012); the explainable RL-013 decision read model; durable
  notifications + support cases with incident correlation (RL-014).
- **Commerce (RL-020..023):** product/catalog, order/subscription
  lifecycles, customer payments/invoices/refunds over proven money facts
  (payment is NOT delivery, RL-LOCK-008), and the commerce-to-connectivity
  evidence reference layer.
- **ADCOS integration (RL-030..036):** the public-client contract package,
  intent + offer/reservation adapters with idempotency, the durable
  HMAC-verified webhook inbox, the §8 projection engine with
  provenance/freshness, the reconciliation engine, and the §9 compatibility
  gate (fail-closed for mutations).
- **Edge (RL-040..044):** capability contracts + observation engine,
  encrypted offline outbox/sync, capability-gated device actions, the
  enterprise edge-connector contract, and platform observability contracts.
- **Platform/security (RL-050..054):** the secrets boundary, the
  tamper-evident audit stream, SLO/error-budget observability primitives,
  resilience (limiters/retries/breakers), retention/privacy enforcement.
- **Product surfaces (RL-060..063):** customer web app, admin/operations
  console, mobile/edge UX shell, enterprise onboarding + `/v1/enterprise`
  API surface with the customer webhook contract.
- **Verification stack (RL-070..075):** authority conformance suites per
  architecture lock (negative-proof, red-on-violation); failure/reordering/
  duplicate simulations; five end-to-end dogfood scenarios; deterministic
  load/reliability suites; security/threat-model verification
  (`docs/threat-model-verification.md`); deployment/recovery verification
  (`docs/deployment-recovery.md`).
- **Release gates (RL-080/RL-081, this wave):** executable, exit-faithful
  gates — `scripts/release/mvp-gate.mjs` (install → lint → typecheck → all
  suites → architecture:check, then the MVP pass criteria) and
  `scripts/release/production-gate.mjs` (MVP as hard prerequisite, then the
  production criteria with the explicit accepted-risk registry
  `docs/reports/accepted-risks.json`); the `@roamlink/tests-release-gates`
  machinery suite; README quickstart; this changelog.

### Known gaps at the MVP gate (honest, recorded — see the gate reports)

- **§11 SLO instrumentation in dogfood/load (gate-blocking):** no dogfood or
  load assertion references any §11 SLO name yet; the observability
  primitives themselves are proven for all nine SLOs by the release-gates
  contract suite. This is why the MVP release gate currently records a FAIL
  verdict (criterion MVP-3) — remediation is a small follow-up in
  `tests/dogfood`/`tests/load` (accepted risk AR-002).
- `spec/current-state.md` still carries greenfield-era status claims
  (accepted risk AR-003 — Tech Lead refresh required).
- Recorded findings accepted for this release with pinned reproducers and
  remediations: RL-074-F1/F2/F3, RL-075-F1, RL-073-DEFECT-1
  (`docs/reports/accepted-risks.json`).
- The inherent-infrastructure verification limits documented by RL-074/075
  remain out of scope for this tree (accepted risk AR-009).

### Verification

`pnpm check` (lint + typecheck + test + architecture:check) is green on the
full workspace: 35 suites — 25 packages, 3 apps, 7 verification suites —
plus the release-gates machinery suite introduced by this wave. Release
gate verdicts and per-criterion evidence: `docs/reports/`.
