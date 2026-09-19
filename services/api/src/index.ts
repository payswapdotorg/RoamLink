/**
 * @roamlink/api-service - the authenticated public API/BFF composition
 * (RL-090) plus the composed readiness surface (RL-100).
 *
 * Layout:
 *  - `api-service.ts` the service: authenticated /v1 dispatch over the
 *    app-kit HttpRequest/HttpResponse contract (transport-independent; the
 *    host adapter translates HTTP, nothing more) + the unauthenticated
 *    GET /v1/readiness composed readiness route (RL-100);
 *  - `readiness.ts`   the composed readiness surface (RL-100): the REAL
 *    per-dependency probes (bound through the provider ports at
 *    composition) aggregated into the honest vocabulary
 *    ready | degraded:<dep> | not-ready:<reason>;
 *  - `envelope.ts`    the server-side command envelope (RL-LOCK-014) and the
 *    bearer-token session authentication gate (@roamlink/auth boundary);
 *  - `commands.ts`    the durable command ingestion: header-envelope
 *    validation, tenant authorization, idempotency-key dedupe, the stored
 *    command ledger + outbox enqueue in ONE real unit of work;
 *  - `http.ts`        RoamLinkError -> HTTP mapping (mirrors the app-kit
 *    fake API's statuses; unknown failures fail closed).
 *
 * Call-chain discipline (spec/deployment.md §4):
 *   HTTP -> application command/query -> domain/integration -> persistence.
 * Route handlers never touch the database; they translate transport only.
 */
export * from "./http.js";
export * from "./readiness.js";
export * from "./envelope.js";
export * from "./commands.js";
export * from "./api-service.js";
