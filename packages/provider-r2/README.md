# @roamlink/provider-r2

The **object-storage adapter surface** (RL-098) — Cloudflare R2 for large
artifacts, exactly per `spec/deployment.md` §2/§8 and ADR-0003.

## The rule this package enforces by construction

> R2 is object storage for LARGE artifacts (support attachments,
> diagnostic exports, downloadable reports, large non-relational
> evidence, application-level-encrypted backups). It is NEVER relational
> authority and never a source of truth for business state.

- **Closed blob surface**: put / get / delete / list / presign — no query
  surface, no relational semantics. Absence (`get -> null`) is a valid
  answer, never an error.
- **Bounded admission**: per-object size bound (default 100 MiB),
  presign lifetimes bounded (default 1 h), metadata bounded and
  printable — credentials are never metadata (RL-LOCK-016).
- **Key conventions enforced** (`OBJECT_KEY_PATTERN` + traversal ban) and
  documented (`buildContentAddressedKey`): content-addressed,
  tenant-scoped, dated keys so re-uploads are idempotent:
  `attachments/<orgId>/<yyyy>/<mm>/<sha256[:16]>-<filename>`.

## Surfaces

| Export | Role |
|---|---|
| `ObjectStoragePort` | The replaceable storage port |
| `InMemoryObjectStorage` | Deterministic fake (bounded, no network) |
| `S3ObjectStorageClient` | Hosted adapter over R2's S3-compatible API — dependency-free AWS SigV4 (header auth + presigned query URLs), strict closed-shape ListObjectsV2 XML parser, injected `fetchLike` |
| `buildContentAddressedKey` / `sanitizeObjectFilename` | The key-namespacing conventions |
| `tryParseR2Env` | Fail-closed `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_ENDPOINT` handling (secret-redacting) |
| `createObjectStorageHealthCheck` | Real probe through the port (any structured answer = healthy) |
| `defineObjectStorageContract` | The reusable battery (ADR-0003 replacement rule) |
| `signHeaderAuth` / `presignUrl` / SigV4 primitives | The ONE signing site — anchored in tests to the AWS documentation's published SigV4 vector |

## Contract tests (port parity + signature proof)

The same behavioral battery runs against (a) the in-memory fake and (b)
the S3 client over an in-memory S3-compatible server that **validates
SigV4 signatures by rebuilding the canonical request from the raw wire
request** — signing, header selection, payload hashing, presigned-URL
expiry and the XML list path are all exercised with zero network and
deterministic clocks.

## Honest wire-contract notes (AR-009)

The S3 REST subset, ListObjectsV2 XML shapes and SigV4 details are pinned
from the published S3/R2 documentation and verified against known AWS
vectors; live confirmation against a real R2 account is the operator's
RL-100+ phase (no cloud credentials exist in the build sandbox). Scoped
per-bucket credentials and CORS for direct browser uploads are configured
at deploy time per the runbook.
