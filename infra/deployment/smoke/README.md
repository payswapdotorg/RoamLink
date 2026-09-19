# RoamLink synthetic smoke journey (RL-100)

The deployment's final §7 gate made executable: "synthetic smoke journey
is green". This suite exercises a DEPLOYED stack end-to-end — WITHOUT
real customer data and WITHOUT secrets — and FAILS if a dependency lies.

Zero dependencies, Node >= 22, plain ESM. Deliberately NOT a
pnpm-workspace package: it has no build/test surface for the release
gates — it is the operator's script (see `../runbooks/deployment-runbook.md`
§6b for the deploy → wait ready → run smoke → record loop).

## Run

```bash
# from the repository root (the root package.json wires the scripts):
BASE_URL=https://roamlink-demo.example.org pnpm smoke

# split deployment (API on its own origin):
BASE_URL=https://roamlink.example.org API_URL=https://api.roamlink.example.org pnpm smoke

# bounded per-request budget (default 10000 ms):
SMOKE_TIMEOUT_MS=15000 BASE_URL=... pnpm smoke

# or directly:
BASE_URL=... node infra/deployment/smoke/run.mjs
```

Exit codes: `0` every check passed; `1` one or more checks failed (or the
target is unreachable); `2` misconfigured invocation (BASE_URL missing).

## The checks

| Check | Asserts |
| --- | --- |
| `healthz` | `GET /healthz` -> 200 `{status:"alive"}` (process liveness). |
| `readyz-vocabulary` | `GET /readyz` answers the HONEST vocabulary `ready \| degraded:<dep,...> \| not-ready:<reason,...>`; the HTTP code tracks servability (200 ready/degraded, 503 not-ready); per-dependency `checks[]` present with `healthy/degraded/down` states. |
| `api-readiness-vocabulary` | `GET /v1/readiness` (the composed API surface) obeys the same laws. |
| `home-surface` | `GET /` is reachable and renders the expected markup: 200 with the shell (or 303 -> `/login` rendering the login document with its markers) — the unauthenticated render IS the expected render. |
| `admin-surface` | `GET /admin` is mounted: 200 or 303 -> `/login`, never 404/5xx. |
| `static-assets` | Every same-origin asset referenced by the collected shell HTML responds (< 400; bounded count). With no surfaces collected this check FAILS (absence of evidence is not a pass). |
| `webhook-ingress-fail-closed` | `POST /v1/webhooks/adcos` with a deterministic UNSIGNED payload is rejected 400/401 (mounted + fail-closed; creates no durable state). |

## The no-lie law (the reason this suite exists)

The smoke must FAIL if a dependency lies:

- a `ready` claim while ANY per-dependency check reports degraded/down is
  a FAIL (`A DEPENDENCY LIES: ...`);
- a status outside the honest vocabulary is a FAIL;
- a servability-code mismatch (`not-ready:*` answered with 200) is a FAIL;
- an unhealthy dependency that is neither named in the status string nor
  explained in its per-check detail is a FAIL (hidden state);
- an inverted status (`degraded:*` with zero unhealthy deps) is a FAIL.

HONEST degradation PASSES: a `degraded:redis` status (HTTP 200, the
accelerator's down state surfaced per-check) is the deployment telling
the truth — surfacing is not failure; only dishonesty fails.

## Selftest (proves the runner, not a deployment)

```bash
pnpm smoke:selftest     # or: node infra/deployment/smoke/selftest.mjs
```

In-process loopback stubs assert the exit-0 path (honest deployment) and
every lie-detection path (ready-over-down, out-of-vocabulary status,
servability mismatch, hidden state, missing webhook ingress, unreachable
target). No network beyond loopback, no secrets.

## Honest gap (AR-009)

This sandbox has no real cloud credentials, so the smoke has been verified
against in-process stub servers (selftest + manual CLI runs), NOT against
a live Vercel/Neon deployment. First real-environment execution is the
operator's RL-118 phase; wire drift found there is fixed single-sited
here (the smoke reads only the frozen vocabulary contract).
