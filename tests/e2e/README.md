# @roamlink/tests-e2e

The RL-113 **user-journey E2E suite**: the twelve §18 journeys
(spec/tech-lead-handoff.md §18) driven through the REAL hosted composition —
the full hosted chain, with NO fake API and NO mocked journey state anywhere
in the path:

```
CustomerWebApp (apps/web: renderDocument/renderPage + typed flow methods)
  -> RoamLinkApiClient (@roamlink/app-kit) over a REAL transport
    -> the host's /v1 mount (handleV1 -> services/api)
      -> @roamlink/auth (session, authorization)
        -> REAL PostgreSQL (pglite) + the REAL infra/migrations
```

The harness (`src/host.ts`) boots the composition exactly as
`apps/portal-host/test/journey.test.ts` does (pglite in development mode,
the deployment migration runner over `infra/migrations`), registers the
journey customer through the REAL auth administration boundary, signs in
through the REAL hosted login form binding, and binds the app-kit client to
a transport that dispatches into the host's `handleV1` route handler.
Document-level assertions only (string HTML + data-attribute scanners) — no
browser, no jsdom, no playwright.

## The honest terrain (what the suite asserts)

The real hosted runtime composes the **command plane** (durable command
ingestion with ledger + outbox, session/login, the stored-command view,
signed webhook admission) and answers every business **read model** with the
typed `501 READ_MODEL_NOT_COMPOSED`. The journeys assert exactly that split,
per journey and per dimension of spec/user-journey-audit.md §11 (entry
point, discoverability, primary task completion, degraded state, recovery
state, support escape hatch, mobile variant):

- what the command plane reaches is pinned (accepted-at, replay,
  idempotency-conflict, durable command-status views, admission dedupe);
- what it does not reach fails closed into the typed error panel — pages
  render the refusal, the shell indicator honestly claims
  "Cannot confirm right now", and **no journey vocabulary stage (including
  "recovered") is ever fabricated** from an unavailable read;
- known gaps are recorded as explicit findings in the tests (never
  silently-passing assertions) — see the catalog's finding column.

## Journey catalog

| File | Journeys (§18) | Highlights / recorded findings |
|---|---|---|
| `hosted-entry-onboarding-goals.test.ts` | entry (land → sign in → Home), onboarding, goal creation/editing | login form → httpOnly cookie → honest Home; all six goal choices discoverable; enrollment command durable (ledger + outbox exact counts); goal ACTIVATION honestly cannot complete (`ONBOARDING_GOAL_NOT_CREATED` — the created goal id is never fabricated); versioned goal commands refuse to command blind when the read-first lookup 501s; FINDING: the typed client cannot parse the real `/v1/users/me` body (`personalTenantId`/`sessionExpiresAt` are unknown fields to `parseActorSessionResource` → `RESPONSE_CONTRACT_VIOLATION`) — app surfaces calling `getActorSession()` (Settings, Workspace) fail closed on this runtime |
| `hosted-devices-connectivity-recovery.test.ts` | device enrollment, connectivity observation, degraded connectivity, automatic recovery | devices/connectivity pages fail closed with the unverifiable shell indicator; update/retire refuse versionless commands; automatic recovery = idempotent replay + typed idempotency CONFLICT on payload drift + durable stored-command recovery + replay-safe webhook admission (`ADMITTED` → `DUPLICATE`, one inbox row); admission is NOT truth (RL-LOCK-009 end to end) |
| `hosted-commerce-support.test.ts` | activity explanation, purchase, delivery, support | notification-read command durable; order + payment commands durable; the delivery-progress view fails closed instead of rendering payment-as-delivery (RL-LOCK-008); the four-stage pipeline is readable from the durable stored-command view with ONLY `accepted` reached; support case (with related refs) filed durably; same-key replays replay the same acknowledgement |
| `hosted-offline-edge-enterprise.test.ts` | offline edge (the apps/mobile mobileDocument legs — Now/Capabilities/Controls/Outbox), enterprise onboarding | the REAL edge shell offline: observation continues, desired action QUEUED (queued ≠ executed), honest offline banner + freshness + gate previews + encrypted-outbox boundary states; FINDING: the enterprise workspace read is not composed AND not even in the real API's read-model refusal set (`/v1/enterprise/workspace` answers plain `404 NOT_FOUND`) — the enterprise journey cannot complete on this runtime |

## Determinism and scope

Every journey boots its own composition; customers derive from deterministic
seeds; no sleeps, no network, no ambient time (the composition clock is
pinned). The suite reuses the PUBLIC `@roamlink/portal-host` exports
(composition + handlers) and adds no exports to any other package — missing
surfaces are stop-and-report findings, not forks.
