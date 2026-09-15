# Tech Lead / Orchestrator Protocol

## Mission

Build the complete RoamLink architecture in this repository without architectural drift. The repository is the source of truth.

## Authority hierarchy

1. `spec/architecture-lock.md`
2. `spec/architecture.md`
3. `spec/authority-model.md`
4. `spec/adcos-integration.md`
5. approved ADRs
6. work-item definitions and dependency graph
7. implementation code
8. tests/fixtures as verification evidence

When lower layers disagree with higher layers, stop and resolve the discrepancy; do not reinterpret the higher layer locally.

## Startup procedure

Before assigning work:

1. Read all `spec/*.md` architecture/governance files.
2. Read every approved ADR.
3. Inspect repository tree and current implementation.
4. Inspect the supported ADCOS Developer API contract and version used by the integration.
5. Run the baseline test/lint/type/build commands.
6. Construct the current work graph from `spec/work-items.md` and `spec/dependency-graph.md`.
7. Record the current implementation state in the work-item tracker/PR descriptions.

## Worker contract

Each worker receives:

- exact work-item IDs;
- relevant architecture sections/locks;
- explicit input contracts;
- allowed files/modules;
- dependencies already satisfied;
- definition of done;
- required tests.

Workers must:
- implement only assigned scope;
- reuse existing contracts rather than inventing parallel ones;
- update tests/specs when behavior changes;
- stop when an architectural dependency is missing;
- never silently modify a frozen invariant.

## Three-worker operating model

Use three concurrent workers where dependencies permit. Prefer one bounded context per worker:

**Worker A — Experience/Commerce**
Owns Experience, customer, device registry, intent, product, order/subscription and customer payment domains.

**Worker B — ADCOS Integration/Data**
Owns ADCOS client/mappers, webhook inbox, projections, reconciliation and ADCOS contract tests.

**Worker C — Edge/Platform**
Owns edge contracts/implementation, sync/outbox, platform security/observability/deployment foundations and conformance harness.

The orchestrator owns cross-worker contracts, merges, release gates and any shared authority changes.

## Before merge

Orchestrator checks:

- architecture locks remain intact;
- no new authority exists;
- imports/dependencies are directional;
- state transitions are explicit;
- retries/reordering/failure are covered;
- evidence/freshness is preserved;
- tests prove the intended architectural invariant;
- no worker has duplicated another worker's authority.

## Stop conditions

Stop implementation and write an ADR/blocker when:

- ADCOS public API cannot support an assumed operation;
- an implementation requires internal ADCOS imports;
- a mobile/platform capability is unavailable;
- two modules both need to become authoritative for the same state;
- a state transition is ambiguous between customer commerce and connectivity delivery;
- security/privacy requirements conflict with a proposed feature.

## Integration gates

After every wave:

1. run all checks;
2. inspect changed dependency edges;
3. run architecture conformance tests;
4. exercise end-to-end scenario(s);
5. update work-item status;
6. only then release the next wave.

## Dogfood scenarios

At minimum test:

- individual travel with preferred Wi-Fi and cellular fallback;
- small business with primary/fallback networks;
- enterprise organization with policies and multiple devices;
- offline edge followed by reconnect/reconciliation;
- ADCOS webhook duplication/reordering/drop;
- customer payment success followed by connectivity failure;
- ADCOS reservation/path success followed by provider/access degradation;
- unsupported mobile capability requiring graceful degradation.

## Final release rule

Do not declare completion because all tickets are green. Completion requires all release gates plus an architecture audit showing that RoamLink remains a Connectivity Experience OS above ADCOS rather than a second connectivity OS.
