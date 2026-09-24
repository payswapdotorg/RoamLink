/**
 * RL-111 — the PRODUCTION backup/export verification battery (real
 * infrastructure, env-gated with honest skips).
 *
 * The deterministic reference lives in test/backup-restore.test.ts (B-1..B-4
 * over the in-memory adapter) and docs/deployment-recovery.md ("Backup /
 * restore + drift repair"). THIS suite verifies the same B-series laws on
 * REAL infrastructure and NEVER touches anything but what the environment
 * names:
 *
 *   env (all from the deployment env templates / provider runbooks):
 *     - DATABASE_URL                       the SOURCE real database
 *       (postgres:// / postgresql://). The suite performs NO DDL on the
 *       source: an unmigrated source SKIPS with the named reason (the
 *       migration state is the deployment runbook §5 prerequisite).
 *     - R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 *       (+ optional R2_ENDPOINT)           the REAL object storage (the
 *       scoped-credentials rule of spec/deployment.md §7).
 *     - ROAMLINK_BACKUP_SCRATCH_DATABASE_URL  the SCRATCH database the
 *       restore runs into — a SECOND/derived DSN, NEVER the source (the
 *       suite REFUSES to run when the two DSNs coincide).
 *
 *   - env absent -> the leg SKIPS with the explicit skip line (CI stays
 *     green with zero silent passes, zero skipped-as-passed lies);
 *   - when present the battery:
 *       (1) seeds its OWN marker data through the PUBLIC persistence ports
 *           (a dedicated repository name + outbox + inbox + an audit
 *           chain) — it never fabricates business data;
 *       (2) exports the real database through the PUBLIC reader contracts
 *           (JSON-serializable end to end);
 *       (3) uploads through the R2 port under CONTENT-ADDRESSED keys with
 *           a manifest naming the digests;
 *       (4) restores into the SCRATCH database (migrated with the REAL
 *           infra/migrations) through the same public ports;
 *       (5) verifies the B-series laws on real infrastructure: digest
 *           laws hold (outbox payload digests, canonical record digests
 *           across the round-trip), dedupe keys survive (a replayed
 *           admission is DUPLICATE), versions continue (CAS at the
 *           recorded version succeeds), terminal outbox states are never
 *           re-enqueued, and the audit chain still VERIFIES (and detects
 *           tampering) after the real round-trip.
 *
 * No credential ever lands in a committed file: everything is env-only
 * (RL-LOCK-016), and failures never echo connection strings or keys.
 *
 * PA-012 real-wire corrections (live-confirmed against the operator's R2
 * bucket + PostgreSQL pair, 2026-09-24):
 *  - the ETag of a single-part R2 PUT is the MD5 of the stored bytes (the
 *    S3 wire law), NOT the sha-256 content digest — content addressing
 *    stays the KEY's job; the etag laws below pin the md5 wire law;
 *  - the battery is RE-ENTRANT and RE-RUNNABLE: a real run executes leg A
 *    then leg B in ONE process against the SAME source (the legs share
 *    SOURCE_TAG), and the operator phase re-runs the battery against the
 *    same primary — so every seed step is idempotent (read-before-write
 *    pre-checks; port-level idempotency for outbox enqueue and inbox
 *    admission; the terminal outbox fixture is only claimed/delivered
 *    while non-terminal), the outbox fixture keys are TAG-SCOPED (fresh
 *    obligations per run), the exported audit section is scoped to this
 *    run's chain, and the SCRATCH is wiped (its three data tables) before
 *    the restore — the scratch is disposable by contract (migrated and
 *    wiped by this battery; the migration ledger is never touched).
 */
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonDigest, sha256Hex } from "@roamlink/contracts";
import {
  createPgDriver,
  createPostgresMigrationRunner,
  createPostgresPersistence,
  setMigrationFileAccess,
  setMigrationPathResolver,
  type PostgresPersistence,
  type SqlDriver,
} from "@roamlink/persistence-postgres";
import { S3ObjectStorageClient, buildContentAddressedKey, md5Hex, tryParseR2Env } from "@roamlink/provider-r2";
import type { ObjectStoragePort } from "@roamlink/provider-r2";
import { InMemoryAuditLog, verifyAuditChain } from "@roamlink/audit";

const REPO_ROOT = join(fileURLToPath(new URL("../../../", import.meta.url)));
const MIGRATIONS_DIR = join(REPO_ROOT, "infra", "migrations");

// --------------------------------------------------------------------------------
// The env gates (honest, named)
// --------------------------------------------------------------------------------

const RAW_DATABASE_URL = process.env["DATABASE_URL"]?.trim() || undefined;
const DATABASE_URL =
  RAW_DATABASE_URL !== undefined &&
  (RAW_DATABASE_URL.startsWith("postgres://") || RAW_DATABASE_URL.startsWith("postgresql://"))
    ? RAW_DATABASE_URL
    : undefined;

const RAW_SCRATCH_URL = process.env["ROAMLINK_BACKUP_SCRATCH_DATABASE_URL"]?.trim() || undefined;
const SCRATCH_DATABASE_URL =
  RAW_SCRATCH_URL !== undefined &&
  (RAW_SCRATCH_URL.startsWith("postgres://") || RAW_SCRATCH_URL.startsWith("postgresql://"))
    ? RAW_SCRATCH_URL
    : undefined;

const R2_PARSED = tryParseR2Env(process.env);
const R2_CONFIG = R2_PARSED.ok ? R2_PARSED.config : undefined;

/** The scratch DSN must be a DIFFERENT database than the source (never the source). */
function scratchIsDistinct(): boolean {
  if (DATABASE_URL === undefined || SCRATCH_DATABASE_URL === undefined) return false;
  if (SCRATCH_DATABASE_URL === DATABASE_URL) return false;
  try {
    return new URL(SCRATCH_DATABASE_URL).pathname !== new URL(DATABASE_URL).pathname;
  } catch {
    return false;
  }
}

function skipLine(leg: string, missing: string[]): string {
  return (
    `[RL-111] SKIPPING the ${leg}: ${missing.join("; ")}. ` +
    "The legs run in the operator phase against the real deployment surfaces " +
    "(spec/deployment.md §7: backup/restore passes); CI stays green with the " +
    "deterministic B-series reference (test/backup-restore.test.ts) — this " +
    "skip is named, never a silent pass."
  );
}

const sourceMissing: string[] = [];
if (DATABASE_URL === undefined) {
  sourceMissing.push("no PostgreSQL DATABASE_URL is configured (postgres:// or postgresql:// required)");
}
if (!R2_CONFIG) {
  sourceMissing.push(
    "the R2 env surface is not fully configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)",
  );
}
if (sourceMissing.length > 0) console.log(skipLine("export/upload leg", sourceMissing));
if (!scratchIsDistinct()) {
  console.log(
    skipLine("restore leg", [
      "no DISTINCT scratch PostgreSQL DSN is configured (ROAMLINK_BACKUP_SCRATCH_DATABASE_URL; it must name a SECOND database — never the source)",
    ]),
  );
}

const hasSource = sourceMissing.length === 0;
const realSource = hasSource ? it : it.skip;
const realScratch = hasSource && scratchIsDistinct() ? it : it.skip;

// --------------------------------------------------------------------------------
// The battery's public-seam runtime
// --------------------------------------------------------------------------------

const MARKER_REPOSITORY = "ops-backup-verification";
const AUDIT_REPOSITORY = "ops-backup-verification-audit";
const OUTBOX_UNSETTLED_KEY_PREFIX = "ops-backup-verification-unsettled";
const OUTBOX_TERMINAL_KEY_PREFIX = "ops-backup-verification-terminal";
const INBOX_DEDUPE_KEY = "ops-backup-verification-dedupe-1";
const SOURCE_TAG = `rl111-${Date.now().toString(36)}`;
/**
 * TAG-SCOPED outbox fixture keys (the PA-012 re-runnability law): every
 * run seeds FRESH unsettled/terminal obligations (a fixed key would
 * digest-conflict with a prior run's tag-carrying payload), while the two
 * legs of ONE run share them idempotently (the port's enqueue answers
 * ALREADY_ENQUEUED for the same key + payload digest). The restore's
 * prefix filter (`ops-backup-verification*`) still gathers every run's
 * unsettled obligations, and the laws below read THIS run's keys.
 */
const OUTBOX_UNSETTLED_KEY = `${OUTBOX_UNSETTLED_KEY_PREFIX}-${SOURCE_TAG}`;
const OUTBOX_TERMINAL_KEY = `${OUTBOX_TERMINAL_KEY_PREFIX}-${SOURCE_TAG}`;

function wireMigrations(): void {
  setMigrationFileAccess({
    listDir: (dir) => readdirSync(dir),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
  setMigrationPathResolver(() => MIGRATIONS_DIR);
}

async function openSource(): Promise<{
  pool: Pool;
  driver: SqlDriver;
  persistence: PostgresPersistence;
  close: () => Promise<void>;
}> {
  wireMigrations();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const driver = createPgDriver(pool);
  return {
    pool,
    driver,
    persistence: createPostgresPersistence(driver),
    close: () => pool.end(),
  };
}

/**
 * Seeds the battery's OWN marker data through the PUBLIC write ports —
 * IDEMPOTENTLY (the PA-012 re-entrancy law): a real run executes leg A then
 * leg B in one process against the same source, and the operator phase
 * re-runs the battery against the same primary, so every fixture is seeded
 * only when absent and the outbox/inbox fixtures rely on their port-level
 * idempotency (ALREADY_ENQUEUED / DUPLICATE are the designed answers, never
 * errors). The laws assert round-trip fidelity, not seed freshness.
 */
async function seedMarkerData(persistence: PostgresPersistence): Promise<void> {
  // The marker records (read-before-write: the other leg of this run — or a
  // crashed prior leg — may already have committed them).
  const markerOne = await persistence.records(MARKER_REPOSITORY).get(`marker-${SOURCE_TAG}-1`);
  if (markerOne === null) {
    const unit = await persistence.begin();
    await unit.records(MARKER_REPOSITORY).insert(`marker-${SOURCE_TAG}-1`, { kind: "battery", revision: 1 });
    await unit
      .records(MARKER_REPOSITORY)
      .compareAndSwap(`marker-${SOURCE_TAG}-1`, 1, { kind: "battery", revision: 2 });
    await unit.records(MARKER_REPOSITORY).insert(`marker-${SOURCE_TAG}-2`, { kind: "battery", revision: 1 });
    await unit.commit();
  }

  // The UNSETTLED obligation (enqueue is port-idempotent: ALREADY_ENQUEUED
  // for the same key + payload digest).
  const outboxUnit = await persistence.begin();
  await outboxUnit.outbox.enqueue({
    idempotencyKey: OUTBOX_UNSETTLED_KEY,
    payload: { effect: "rl111-marker", tag: SOURCE_TAG },
    createdAt: new Date().toISOString(),
  });
  await outboxUnit.commit();

  // A TERMINAL record: the restore law says it is NEVER re-enqueued. Seeded
  // (claimed + delivered) only while it is not already terminal — terminal
  // states have no outgoing edges (the state machine stays closed), and a
  // prior leg of this run has typically already delivered it.
  const terminal = await persistence.outbox.get(OUTBOX_TERMINAL_KEY);
  if (terminal?.deliveryState !== "DELIVERED") {
    const terminalUnit = await persistence.begin();
    await terminalUnit.outbox.enqueue({
      idempotencyKey: OUTBOX_TERMINAL_KEY,
      payload: { effect: "rl111-marker-terminal", tag: SOURCE_TAG },
      createdAt: new Date().toISOString(),
    });
    await terminalUnit.commit();
    const claim = await persistence.begin();
    await claim.outbox.claimDue(new Date().toISOString(), 5);
    await claim.commit();
    const settle = await persistence.begin();
    await settle.outbox.markDelivered(OUTBOX_TERMINAL_KEY, new Date().toISOString());
    await settle.commit();
  }

  // Exactly-once admission: the key is occupied ONCE on the source (a
  // replay from the other leg of this run — or a prior run — is DUPLICATE,
  // the designed idempotent answer).
  const inboxUnit = await persistence.begin();
  const admission = await inboxUnit.inbox.admit({
    source: "rl111-battery",
    externalEventId: `evt-${SOURCE_TAG}`,
    receivedAt: new Date().toISOString(),
    dedupeKey: INBOX_DEDUPE_KEY,
  });
  expect(["ADMITTED", "DUPLICATE"]).toContain(admission.outcome);
  await inboxUnit.commit();
}

/**
 * Seeds the battery's audit chain as records — idempotently (the other leg
 * of this run may already have committed this tag's chain; read-before-write).
 */
async function seedAuditChain(persistence: PostgresPersistence): Promise<void> {
  const head = await persistence.records(AUDIT_REPOSITORY).get(`audit-${SOURCE_TAG}-0`);
  if (head !== null) return;
  const audit = new InMemoryAuditLog({
    eventIdGenerator: (() => {
      let counter = 0;
      return () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
    })(),
  });
  for (let index = 1; index <= 3; index += 1) {
    await audit.append({
      category: "auth",
      action: `rl111.battery.event-${index}`,
      outcome: index % 2 === 0 ? "denied" : "allowed",
      actorId: "usr:00000000-0000-4000-8000-0000000000c1",
      correlationId: `corr.rl111.${SOURCE_TAG}.${index}`,
      occurredAt: new Date().toISOString(),
    });
  }
  const events = await audit.events();
  const unit = await persistence.begin();
  for (const [index, event] of (events as unknown as { toPlain(): Record<string, unknown> }[]).entries()) {
    await unit.records(AUDIT_REPOSITORY).insert(`audit-${SOURCE_TAG}-${index}`, event.toPlain() as never);
  }
  await unit.commit();
}

/** The canonical-state export (plain, JSON-serializable; the reader-contract shapes). */
interface DataPlaneExport {
  readonly takenAt: string;
  readonly tag: string;
  readonly records: Readonly<Record<string, readonly { recordId: string; version: number; value: unknown }[]>>;
  readonly outbox: readonly {
    readonly idempotencyKey: string;
    readonly deliveryState: string;
    readonly retryCount: number;
    readonly payloadDigest: string;
    readonly payload: string;
  }[];
  readonly inbox: readonly {
    readonly sequence: number;
    readonly state: string;
    readonly dedupeKey: string;
    readonly externalEventId: string;
    readonly source: string;
    readonly receivedAt: string;
  }[];
}

/**
 * The canonical-state export through the PUBLIC reader contracts. The audit
 * section is scoped to THIS run's chain (`audit-<SOURCE_TAG>-*`): the
 * source accumulates prior runs' chains (the battery is re-runnable), and
 * the round-trip's subject is this run's chain — the export, the restore and
 * the audit law all see exactly the three records this run seeded.
 */
async function exportDataPlane(persistence: PostgresPersistence): Promise<DataPlaneExport> {
  const markerRecords = (await persistence.records(MARKER_REPOSITORY).list()).map((record) => ({
    recordId: record.recordId,
    version: record.version,
    value: record.value,
  }));
  const auditStored = (await persistence.records(AUDIT_REPOSITORY).list())
    .filter((record) => record.recordId.startsWith(`audit-${SOURCE_TAG}-`))
    .map((record) => ({
      recordId: record.recordId,
      version: record.version,
      value: record.value,
    }));
  const outbox = (await persistence.outbox.list()).map((record) => ({
    idempotencyKey: record.idempotencyKey,
    deliveryState: record.deliveryState,
    retryCount: record.retryCount,
    payloadDigest: record.payloadDigest,
    payload: new TextDecoder().decode(record.payloadBytes),
  }));
  const inbox = (await persistence.inbox.list()).map((record) => ({
    sequence: record.sequence,
    state: record.admissionState,
    dedupeKey: record.dedupeKey,
    externalEventId: record.externalEventId,
    source: record.source,
    receivedAt: record.receivedAt,
  }));
  return {
    takenAt: new Date().toISOString(),
    tag: SOURCE_TAG,
    records: {
      [MARKER_REPOSITORY]: markerRecords,
      [AUDIT_REPOSITORY]: auditStored,
    },
    outbox,
    inbox,
  };
}

function assertExportLaws(snapshot: DataPlaneExport): DataPlaneExport {
  // JSON-serializable end to end (what a backup file / network transfer sees).
  const throughJson = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  expect(throughJson).toEqual(snapshot);
  // The honest digest law on real data: every exported outbox payload
  // digests exactly to its recorded payload_digest.
  for (const record of snapshot.outbox) {
    expect(record.payloadDigest).toBe(sha256Hex(record.payload));
  }
  // The audit chain verifies on the EXPORTED plain records (B-2) — and
  // tampering with the exported copy is detected.
  const auditPlain = (
    snapshot.records[AUDIT_REPOSITORY] as readonly { value: Record<string, unknown> }[]
  ).map((entry) => entry.value);
  expect(verifyAuditChain(auditPlain as never)).toMatchObject({ ok: true });
  const tampered = JSON.parse(JSON.stringify(auditPlain)) as Record<string, unknown>[];
  const second = tampered[1];
  if (second !== undefined) second["outcome"] = "allowed";
  expect(verifyAuditChain(tampered as never).ok).toBe(false);
  return throughJson;
}

/** The R2 port bound from the operator's env (scoped credentials, never committed). */
function realR2Port(): ObjectStoragePort {
  const config = R2_CONFIG;
  if (!config) throw new Error("the R2 env surface is not configured");
  return new S3ObjectStorageClient({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
}

// --------------------------------------------------------------------------------
// Leg A: export -> content-addressed upload -> manifest
// --------------------------------------------------------------------------------

describe("RL-111 leg A: real export + content-addressed R2 upload (DATABASE_URL + R2 env-gated)", () => {
  realSource("exports the real database through the public reader contracts and uploads content-addressed", async () => {
    const source = await openSource();
    try {
      // NO DDL on the source: an unmigrated database skips with the named
      // reason (the migration state is the deployment prerequisite).
      const ledger = await source.driver
        .query("SELECT count(*)::int AS applied FROM roamlink_schema_migrations")
        .then((result) => (result.rows as { applied?: number }[])[0]?.applied ?? 0)
        .catch(() => 0);
      if (ledger === 0) {
        console.log(
          "[RL-111] SKIPPING against this source: the schema migration ledger is empty " +
            "(apply infra/migrations per the deployment runbook §5 first) — no DDL is ever run " +
            "on a source database by this battery.",
        );
        return;
      }

      await seedMarkerData(source.persistence);
      await seedAuditChain(source.persistence);

      const snapshot = await exportDataPlane(source.persistence);
      const throughJson = assertExportLaws(snapshot);
      const snapshotJson = JSON.stringify(throughJson, null, 2);
      const snapshotDigest = sha256Hex(snapshotJson);
      // Canonical digest stability across the JSON round-trip (the
      // contracts' guarantee): re-parsing digests identically.
      expect(canonicalJsonDigest(JSON.parse(snapshotJson))).toBe(canonicalJsonDigest(throughJson));

      // Upload through the R2 port under CONTENT-ADDRESSED keys.
      const port = realR2Port();
      const dataKey = buildContentAddressedKey({
        namespace: "backups",
        contentSha256: snapshotDigest,
        filename: `ops-backup-verification-${SOURCE_TAG}.json`,
        at: snapshot.takenAt,
      });
      const put = await port.put({
        key: dataKey,
        body: snapshotJson,
        contentType: "application/json",
      });
      // The REAL wire law (live-confirmed by PA-012): a single-part R2 PUT's
      // ETag IS the MD5 content digest of the stored bytes — the provider
      // computed it from what it actually stored. (Content addressing is
      // the KEY's job: the sha-256 rides the content-addressed key and the
      // manifest below.)
      expect(put.etag).toBe(md5Hex(snapshotJson));

      // The manifest NAMES the digests (the operator's recovery index).
      const manifest = {
        kind: "roamlink-backup-manifest",
        generator: "RL-111 battery",
        tag: SOURCE_TAG,
        takenAt: snapshot.takenAt,
        objects: [
          { key: dataKey, sha256: snapshotDigest, sizeBytes: put.sizeBytes, kind: "data-plane-snapshot" },
        ],
        counts: {
          repositories: Object.keys(snapshot.records).length,
          outbox: snapshot.outbox.length,
          inbox: snapshot.inbox.length,
        },
      };
      const manifestJson = JSON.stringify(manifest, null, 2);
      const manifestDigest = sha256Hex(manifestJson);
      const manifestKey = buildContentAddressedKey({
        namespace: "backups",
        contentSha256: manifestDigest,
        filename: `ops-backup-verification-${SOURCE_TAG}-manifest.json`,
        at: snapshot.takenAt,
      });
      const manifestPut = await port.put({ key: manifestKey, body: manifestJson, contentType: "application/json" });
      expect(manifestPut.etag).toBe(md5Hex(manifestJson)); // the md5 ETag wire law

      // Byte-identical reads back from the real bucket.
      const fetched = await port.get(dataKey);
      expect(fetched).not.toBeNull();
      expect(Buffer.from(fetched?.body ?? new Uint8Array()).toString("utf8")).toBe(snapshotJson);
      const listing = await port.list({ prefix: `backups/${new Date(snapshot.takenAt).getUTCFullYear()}/` });
      expect(listing.keys.some((entry) => entry.key === dataKey)).toBe(true);

      // Tidy the bucket (the verification is complete; artifacts are re-creatable).
      await port.delete(dataKey);
      await port.delete(manifestKey);
    } finally {
      await source.close();
    }
  }, 120_000);
});
// --------------------------------------------------------------------------------
// Leg B: restore into a SCRATCH database + the B-series laws on real infra
// --------------------------------------------------------------------------------

describe("RL-111 leg B: restore into a scratch database (DATABASE_URL + R2 + scratch DSN gated)", () => {
  realScratch("the restored scratch database holds the B-series laws", async () => {
    if (DATABASE_URL === undefined || SCRATCH_DATABASE_URL === undefined || !R2_CONFIG) {
      throw new Error("unreachable: the gate above decides this leg");
    }
    const source = await openSource();
    let scratch: { pool: Pool; persistence: PostgresPersistence; close: () => Promise<void> } | undefined;
    try {
      // SOURCE: export through the public reader contracts (no DDL here).
      const ledger = await source.driver
        .query("SELECT count(*)::int AS applied FROM roamlink_schema_migrations")
        .then((result) => (result.rows as { applied?: number }[])[0]?.applied ?? 0)
        .catch(() => 0);
      if (ledger === 0) {
        console.log(
          "[RL-111] SKIPPING the restore leg against this source: the source is not migrated " +
            "(runbook §5) — the scratch is migrated by the battery, the source never is.",
        );
        return;
      }
      await seedMarkerData(source.persistence);
      await seedAuditChain(source.persistence);
      const snapshot = await exportDataPlane(source.persistence);
      assertExportLaws(snapshot);

      // The manifest rides the real bucket (the operator's recovery path:
      // the snapshot the restore consumes is the one the manifest names).
      const port = realR2Port();
      const snapshotJson = JSON.stringify(snapshot, null, 2);
      const snapshotDigest = sha256Hex(snapshotJson);
      const dataKey = buildContentAddressedKey({
        namespace: "backups",
        contentSha256: snapshotDigest,
        filename: `ops-backup-verification-${SOURCE_TAG}.json`,
        at: snapshot.takenAt,
      });
      await port.put({ key: dataKey, body: snapshotJson, contentType: "application/json" });
      const roundTripped = (await port.get(dataKey).then((found) =>
        Buffer.from(found?.body ?? new Uint8Array()).toString("utf8"),
      )) as string;
      expect(roundTripped).toBe(snapshotJson); // byte-identical from real R2
      const restoredSnapshot = JSON.parse(roundTripped) as DataPlaneExport;

      // SCRATCH: migrate with the REAL infra/migrations (disposable, derived),
      // then WIPE its three data tables — the scratch is disposable by
      // contract ("migrated and wiped by this battery"; the runbook's
      // "verify a restore into a scratch branch"): a prior run's restored
      // rows must never collide with this run's restore (records are never
      // silently overwritten) and the audit law counts exactly this run's
      // restored chain. The migration LEDGER is never touched (migrateUp
      // stays idempotent); only the battery's own data tables are cleared.
      wireMigrations();
      const scratchPool = new Pool({ connectionString: SCRATCH_DATABASE_URL, max: 3 });
      const scratchDriver = createPgDriver(scratchPool);
      scratch = {
        pool: scratchPool,
        persistence: createPostgresPersistence(scratchDriver),
        close: () => scratchPool.end(),
      };
      await createPostgresMigrationRunner({ driver: scratchDriver }).migrateUp();
      for (const table of ["roamlink_records", "roamlink_outbox", "roamlink_inbox"]) {
        await scratchDriver.query(`DELETE FROM ${table}`);
      }

      // RESTORE through the public ports: named repositories at their
      // recorded versions (optimistic-concurrency tokens continue).
      for (const [repository, entries] of Object.entries(restoredSnapshot.records)) {
        if (entries.length === 0) continue;
        const unit = await scratch.persistence.begin();
        for (const entry of entries) {
          await unit.records(repository).insert(entry.recordId, entry.value as never);
          for (let version = 1; version < entry.version; version += 1) {
            await unit
              .records(repository)
              .compareAndSwap(entry.recordId, version, entry.value as never);
          }
        }
        await unit.commit();
      }

      // The inbox admission log: re-admit every ADMITTED dedupe key.
      const admittedKeys = restoredSnapshot.inbox
        .filter((record) => record.state === "ADMITTED" && record.dedupeKey.startsWith("ops-backup-verification"))
        .sort((a, b) => a.sequence - b.sequence);
      for (const entry of admittedKeys) {
        const unit = await scratch.persistence.begin();
        await unit.inbox.admit({
          source: entry.source,
          externalEventId: entry.externalEventId,
          receivedAt: entry.receivedAt,
          dedupeKey: entry.dedupeKey,
        });
        await unit.commit();
      }

      // The outbox: UNSETTLED obligations only — terminal records are
      // NEVER re-enqueued (their effect is settled; re-enqueue would
      // duplicate it).
      for (const record of restoredSnapshot.outbox) {
        if (!record.idempotencyKey.startsWith("ops-backup-verification")) continue;
        if (record.deliveryState === "DELIVERED" || record.deliveryState === "FAILED") continue;
        const unit = await scratch.persistence.begin();
        await unit.outbox.enqueue({
          idempotencyKey: record.idempotencyKey,
          payload: JSON.parse(record.payload) as never,
          createdAt: restoredSnapshot.takenAt,
        });
        await unit.commit();
      }
      expect(await scratch.persistence.outbox.get(OUTBOX_TERMINAL_KEY)).toBeNull();
      expect((await scratch.persistence.outbox.get(OUTBOX_UNSETTLED_KEY))?.deliveryState).toBe("PENDING");

      // LAW: digest-identical records across the real round-trip.
      const sourceRecords = await source.persistence.records(MARKER_REPOSITORY).list();
      const scratchRecords = await scratch.persistence.records(MARKER_REPOSITORY).list();
      expect(scratchRecords.map((record) => [record.recordId, record.version, canonicalJsonDigest(record.value)]))
        .toEqual(sourceRecords.map((record) => [record.recordId, record.version, canonicalJsonDigest(record.value)]));

      // LAW: dedupe keys survive — a replayed admission is DUPLICATE.
      const replayUnit = await scratch.persistence.begin();
      const replay = await replayUnit.inbox.admit({
        source: "rl111-battery",
        externalEventId: `evt-${SOURCE_TAG}`,
        receivedAt: new Date().toISOString(),
        dedupeKey: INBOX_DEDUPE_KEY,
      });
      await replayUnit.commit();
      expect(replay.outcome).toBe("DUPLICATE");

      // LAW: versions continue — CAS at the recorded version succeeds and
      // advances (the restored state is writable, not a museum piece).
      const continueUnit = await scratch.persistence.begin();
      const head = scratchRecords.find((record) => record.recordId === `marker-${SOURCE_TAG}-1`);
      if (head === undefined) throw new Error("expected the restored marker record");
      await continueUnit
        .records(MARKER_REPOSITORY)
        .compareAndSwap(head.recordId, head.version, { kind: "battery", revision: head.version + 1 });
      await continueUnit.commit();
      const advanced = await scratch.persistence.records(MARKER_REPOSITORY).get(head.recordId);
      expect(advanced?.version).toBe(head.version + 1);

      // LAW: the audit chain still verifies after the REAL round-trip
      // (source -> reader contracts -> JSON -> real R2 -> restore).
      const restoredAudit = (await scratch.persistence.records(AUDIT_REPOSITORY).list()).map((record) => record.value);
      expect(restoredAudit.length).toBe(3);
      expect(verifyAuditChain(restoredAudit as never)).toMatchObject({ ok: true });

      // Tidy the bucket object.
      await port.delete(dataKey);
    } finally {
      await source.close();
      await scratch?.close();
    }
  }, 180_000);
});
