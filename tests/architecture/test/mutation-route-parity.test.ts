/**
 * PA-023 — the mutation-route parity law (a repo-level invariant).
 *
 * docs/live-journey-runtime-audit-2026-09-26.md §3 recorded the gap: the
 * rendered customer actions for eSIM install/enable/remove and enterprise
 * connector provisioning were "discoverable ✅ host-wired ✅ real API
 * mutation ❌" — PA-018 proved host form wiring, but not end-to-end API
 * mutation parity. This test keeps that gap CLOSED by parsing the THREE
 * tables the gap lived between and failing on any drift:
 *
 *   1. the CustomerWebApp flow union — the rendered form actions across
 *      apps/web/src/pages/** (every `data-flow` attribute and every
 *      `action: "/flows/<name>"` form target) PLUS the typed flow methods
 *      apps/web/src/app.ts exposes (`async <name>Flow(...)`);
 *   2. the portal-host FLOW_HANDLERS table (apps/portal-host/src/flows.ts —
 *      the host's closed wiring union, F-016-1);
 *   3. the services/api MUTATION_ROUTES table (services/api/src/commands.ts —
 *      the real API's mutation surface).
 *
 * THE LAW (flow union ⊆ API mutation surface):
 *   - every rendered form action is wired in the host table;
 *   - every hosted flow resolves — through the app's typed flow method to
 *     the app-kit client's `#mutate("routeName", ...)` call to the pinned
 *     API_ROUTE_TEMPLATES wire path — to a template that matches EXACTLY ONE
 *     real-API mutation route pattern;
 *   - every typed flow method the app exposes maps the same way (a flow
 *     method whose commands would hit a 404 on the real API is a parity
 *     defect);
 *   - the REVERSE asymmetry is explicit: every real-API mutation kind no
 *     web flow renders must be in the DOCUMENTED exceptions list below, and
 *     every documented exception must still be a real API-only kind (a new
 *     undocumented asymmetry fails; a stale exception entry fails).
 *
 * Structure-only, the house pattern of the wave boundary guards: the tables'
 * source files are read and scanned, never imported — this package declares
 * no app dependency, so the law stays a repo-level fact rather than a
 * compiled-in assumption.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function mustExist(path: string): void {
  expect(readdirSync(join(REPO_ROOT, path)).length > 0, `${path} must exist`).toBe(true);
}

function walkTsFiles(dir: string): string[] {
  const absolute = join(REPO_ROOT, dir);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) {
      return walkTsFiles(join(dir, entry.name));
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Collects all regex matches with their capture groups (always global). */
function collect(source: string, pattern: RegExp): { readonly index: number; readonly groups: readonly string[] }[] {
  const global = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...source.matchAll(global)].map((match) => ({
    index: match.index ?? 0,
    groups: match.slice(1).map((group) => group ?? ""),
  }));
}

// --------------------------------------------------------------------------------
// Table 1a — the rendered flow actions (apps/web/src/pages/**)
// --------------------------------------------------------------------------------

/**
 * The rendered form actions: every `data-flow` attribute AND every
 * `action: "/flows/<name>"` form target across the rendered pages (the
 * onboarding wizard renders its forms with `data-onboarding-form` but the
 * SAME `/flows/<name>` action URL — both renderings count).
 */
function renderedFlowActions(): Set<string> {
  const actions = new Set<string>();
  for (const file of walkTsFiles("apps/web/src/pages")) {
    const source = readFileSync(file, "utf8");
    for (const match of collect(source, /"data-flow":\s*"([^"]+)"/g)) {
      actions.add(match.groups[0] as string);
    }
    for (const match of collect(source, /action:\s*"\/flows\/([^"]+)"/g)) {
      actions.add(match.groups[0] as string);
    }
  }
  return actions;
}

// --------------------------------------------------------------------------------
// Table 1b — the typed flow methods + their client calls (apps/web/src/app.ts)
// --------------------------------------------------------------------------------

/** The app's flow methods -> the app-kit client methods they invoke. */
function appFlowMethodCalls(): Map<string, readonly string[]> {
  const source = read("apps/web/src/app.ts");
  const methodMarkers = collect(source, /(?:^|\n) {2}async\s+(\w+Flow)\s*\(/g);
  const calls = new Map<string, string[]>();
  for (let i = 0; i < methodMarkers.length; i += 1) {
    const marker = methodMarkers[i] as { readonly index: number; readonly groups: readonly string[] };
    const methodName = marker.groups[0] as string;
    const end = i + 1 < methodMarkers.length
      ? (methodMarkers[i + 1] as { readonly index: number }).index
      : source.length;
    const body = source.slice(marker.index, end);
    const clientCalls = [...collect(body, /this\.#client\.(\w+)\(/g)].map((m) => m.groups[0] as string);
    calls.set(methodName, clientCalls);
  }
  return calls;
}

// --------------------------------------------------------------------------------
// Table 2 — the portal-host FLOW_HANDLERS table (apps/portal-host/src/flows.ts)
// --------------------------------------------------------------------------------

/** The hosted flow names -> the typed app flow method each handler runs. */
function hostedFlowHandlers(): Map<string, readonly string[]> {
  const source = read("apps/portal-host/src/flows.ts");
  const markers = collect(source, /const\s+\w+FlowHandler:\s*FlowHandler\s*=\s*\{/g);
  const handlers = new Map<string, string[]>();
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i] as { readonly index: number; readonly groups: readonly string[] };
    const end = i + 1 < markers.length
      ? (markers[i + 1] as { readonly index: number }).index
      : source.length;
    const block = source.slice(marker.index, end);
    const name = collect(block, /name:\s*"([^"]+)"/g)[0]?.groups[0];
    const appCalls = [...collect(block, /ctx\.app\.(\w+)\(/g)].map((m) => m.groups[0] as string);
    expect(name, "every FLOW_HANDLERS entry declares its flow name literal").toBeDefined();
    expect(
      appCalls.length,
      `the '${name ?? "?"}' flow handler must call a typed app flow method`,
    ).toBeGreaterThan(0);
    handlers.set(name as string, appCalls);
  }
  return handlers;
}

// --------------------------------------------------------------------------------
// The linking contracts — app-kit client mutations + route templates
// --------------------------------------------------------------------------------

/** The app-kit client's mutation methods -> their `#mutate("<routeName>")` target. */
function clientMutationRoutes(): Map<string, string> {
  const source = read("packages/app-kit/src/api/client.ts");
  const methodMarkers = collect(source, /(?:^|\n) {2}async\s+(\w+)\(/g);
  const mutations = new Map<string, string>();
  for (let i = 0; i < methodMarkers.length; i += 1) {
    const marker = methodMarkers[i] as { readonly index: number; readonly groups: readonly string[] };
    const end = i + 1 < methodMarkers.length
      ? (methodMarkers[i + 1] as { readonly index: number }).index
      : source.length;
    const body = source.slice(marker.index, end);
    const routeName = collect(body, /this\.#mutate\(\s*"(\w+)"/g)[0]?.groups[0];
    if (routeName !== undefined) {
      mutations.set(marker.groups[0] as string, routeName);
    }
  }
  return mutations;
}

/** The app contract's pinned wire paths (API_ROUTE_TEMPLATES name -> template). */
function apiRouteTemplates(): Map<string, string> {
  const source = read("packages/app-kit/src/api/routes.ts");
  const block = source.slice(
    source.indexOf("export const API_ROUTE_TEMPLATES"),
    source.indexOf("} as const"),
  );
  expect(block.length > 0, "the API_ROUTE_TEMPLATES block must parse").toBe(true);
  const templates = new Map<string, string>();
  for (const match of collect(block, /^ {2}(\w+):\s*"([^"]+)",?$/gm)) {
    templates.set(match.groups[0] as string, match.groups[1] as string);
  }
  return templates;
}

// --------------------------------------------------------------------------------
// Table 3 — the real API's MUTATION_ROUTES table (services/api/src/commands.ts)
// --------------------------------------------------------------------------------

interface MutationRouteEntry {
  readonly pattern: RegExp;
  readonly kind: string;
  readonly patternSource: string;
}

function mutationRoutes(): readonly MutationRouteEntry[] {
  const source = read("services/api/src/commands.ts");
  const block = source.slice(
    source.indexOf("export const MUTATION_ROUTES"),
    source.indexOf("]);", source.indexOf("export const MUTATION_ROUTES")),
  );
  expect(block.length > 0, "the MUTATION_ROUTES block must parse").toBe(true);
  return collect(block, /\{\s*pattern:\s*\/(.+?)\/,\s*kind:\s*"([^"]+)"\s*\}/g).map((match) => {
    const patternSource = match.groups[0] as string;
    return {
      pattern: new RegExp(patternSource),
      kind: match.groups[1] as string,
      patternSource,
    };
  });
}

/** Fills a route template's `{param}` segments with a representative non-slash value. */
function concretePathOf(template: string): string {
  return template.replace(/\{\w+\}/g, "11111111-1111-4111-8111-111111111111");
}

/** Resolves the mutation route kinds a set of app flow methods command. */
function routeKindsOfFlowMethods(
  flowMethods: readonly string[],
  appFlowCalls: ReadonlyMap<string, readonly string[]>,
  clientMutations: ReadonlyMap<string, string>,
  templates: ReadonlyMap<string, string>,
  routes: readonly MutationRouteEntry[],
  origin: string,
): Set<string> {
  const kinds = new Set<string>();
  for (const flowMethod of flowMethods) {
    const clientCalls = appFlowCalls.get(flowMethod);
    expect(
      clientCalls,
      `the ${origin} flow method '${flowMethod}' must exist on CustomerWebApp (apps/web/src/app.ts)`,
    ).toBeDefined();
    let mutated = 0;
    for (const clientCall of clientCalls ?? []) {
      const routeName = clientMutations.get(clientCall);
      if (routeName === undefined) continue; // a read (`#get`) — not a mutation
      mutated += 1;
      const template = templates.get(routeName);
      expect(
        template,
        `the app-kit client's '${routeName}' mutation route must be pinned in API_ROUTE_TEMPLATES`,
      ).toBeDefined();
      const concrete = concretePathOf(template as string);
      const matches = routes.filter((route) => route.pattern.test(concrete));
      expect(
        matches.length,
        `${origin} '${flowMethod}' commands '${template}' — the real API must serve it with EXACTLY ONE mutation route (got ${matches.length}: [${routes
          .filter((route) => route.pattern.test(concrete))
          .map((route) => route.kind)
          .join(", ")}])`,
      ).toBe(1);
      kinds.add((matches[0] as MutationRouteEntry).kind);
    }
    // A flow method that issues NO command is a read helper, not a flow — the
    // union's members must all reach the command plane.
    expect(
      mutated,
      `the typed flow method '${flowMethod}' must issue at least one command (a flow that never mutates is not a form-action flow)`,
    ).toBeGreaterThan(0);
  }
  return kinds;
}

// --------------------------------------------------------------------------------
// The DOCUMENTED exceptions (the API-only mutation kinds no web flow renders)
// --------------------------------------------------------------------------------

/**
 * The service-plane extras: real-API mutation kinds with NO rendered/hosted
 * web flow. This list is the law's explicit documentation — a new API-only
 * asymmetry that is not added here FAILS the law, and an entry that stops
 * being a real API-only kind (a flow starts rendering it, or the route is
 * removed) also FAILS it (stale documentation is drift).
 */
const DOCUMENTED_API_ONLY_KINDS: readonly { readonly kind: string; readonly because: string }[] = [
  {
    kind: "order.complete",
    because: "fulfillment completion is the service operator's command (the customer surface renders place/cancel only)",
  },
  {
    kind: "support-case.transition",
    because: "support-case triage transitions are the support-operations command (the customer surface renders create only)",
  },
  {
    kind: "organization.suspend",
    because: "organization lifecycle is the admin/operations command (no customer web flow renders it)",
  },
  {
    kind: "organization.reactivate",
    because: "organization lifecycle is the admin/operations command (no customer web flow renders it)",
  },
];

// --------------------------------------------------------------------------------
// The law
// --------------------------------------------------------------------------------

describe("PA-023 mutation-route parity law (flow union ⊆ real API mutation surface)", () => {
  it("the three tables' source files exist", () => {
    mustExist("apps/web/src/pages");
    mustExist("apps/portal-host/src");
    mustExist("services/api/src");
  });

  it("every rendered form action is wired in the portal-host FLOW_HANDLERS table", () => {
    const rendered = renderedFlowActions();
    const hosted = hostedFlowHandlers();
    expect(rendered.size, "the rendered flow union must not be empty").toBeGreaterThan(0);
    const unwired = [...rendered].filter((action) => !hosted.has(action)).sort();
    expect(
      unwired,
      "every rendered form action must be wired in the host's FLOW_HANDLERS (an unwired /flows/* target is the F-016-1 defect)",
    ).toEqual([]);
  });

  it("every hosted flow action maps to a real API mutation route (the flow union ⊆ the mutation surface)", () => {
    const hosted = hostedFlowHandlers();
    const appFlowCalls = appFlowMethodCalls();
    const clientMutations = clientMutationRoutes();
    const templates = apiRouteTemplates();
    const routes = mutationRoutes();

    expect(hosted.size, "the hosted flow table must not be empty").toBeGreaterThan(0);
    for (const [flowName, appMethods] of hosted) {
      const kinds = routeKindsOfFlowMethods(
        appMethods,
        appFlowCalls,
        clientMutations,
        templates,
        routes,
        `hosted flow '${flowName}'`,
      );
      expect(
        kinds.size,
        `the hosted flow '${flowName}' must reach at least one real API mutation kind`,
      ).toBeGreaterThan(0);
    }
  });

  it("every typed flow method the app exposes maps to real API mutation routes", () => {
    const appFlowCalls = appFlowMethodCalls();
    const clientMutations = clientMutationRoutes();
    const templates = apiRouteTemplates();
    const routes = mutationRoutes();
    expect(appFlowCalls.size, "the typed flow-method union must not be empty").toBeGreaterThan(0);
    routeKindsOfFlowMethods(
      [...appFlowCalls.keys()],
      appFlowCalls,
      clientMutations,
      templates,
      routes,
      "typed flow method",
    );
  });

  it("the reverse asymmetry is exactly the documented exceptions (no undocumented API-only mutation kinds)", () => {
    const hosted = hostedFlowHandlers();
    const appFlowCalls = appFlowMethodCalls();
    const clientMutations = clientMutationRoutes();
    const templates = apiRouteTemplates();
    const routes = mutationRoutes();

    // The full flow-union closure over the real API's kinds.
    const closureKinds = new Set<string>();
    for (const [flowName, appMethods] of hosted) {
      for (const kind of routeKindsOfFlowMethods(
        appMethods,
        appFlowCalls,
        clientMutations,
        templates,
        routes,
        `hosted flow '${flowName}'`,
      )) {
        closureKinds.add(kind);
      }
    }
    for (const kind of routeKindsOfFlowMethods(
      [...appFlowCalls.keys()],
      appFlowCalls,
      clientMutations,
      templates,
      routes,
      "typed flow method",
    )) {
      closureKinds.add(kind);
    }

    const apiKinds = new Set(routes.map((route) => route.kind));
    const apiOnly = [...apiKinds].filter((kind) => !closureKinds.has(kind)).sort();
    const documented = DOCUMENTED_API_ONLY_KINDS.map((entry) => entry.kind).sort();

    // A new API-only asymmetry without documentation fails.
    expect(
      apiOnly,
      "every real-API mutation kind that no web flow renders must be in the DOCUMENTED exceptions list (an undocumented asymmetry is a parity defect — document it here or wire the flow)",
    ).toEqual(documented);
    // A stale exception entry fails (documentation must stay truthful).
    expect(
      documented.filter((kind) => !apiKinds.has(kind)),
      "every documented exception must still be a real API mutation kind (a stale entry is drift)",
    ).toEqual([]);
    expect(
      documented.filter((kind) => closureKinds.has(kind)),
      "a documented exception that a web flow now renders must be removed from the list (it is no longer API-only)",
    ).toEqual([]);
  });

  it("the four PA-023 wire paths are real API mutation routes (the audit §3 gap stays closed)", () => {
    const templates = apiRouteTemplates();
    const routes = mutationRoutes();
    for (const routeName of [
      "deviceSimInstall",
      "deviceSimProfileRemove",
      "deviceSimProfileEnable",
      "enterpriseConnectorProvision",
    ]) {
      const template = templates.get(routeName);
      expect(template, `the app contract pins the '${routeName}' route template`).toBeDefined();
      const concrete = concretePathOf(template as string);
      const matches = routes.filter((route) => route.pattern.test(concrete));
      expect(
        matches.length,
        `'${template}' must be served by exactly one real API mutation route`,
      ).toBe(1);
    }
  });
});
