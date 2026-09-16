/**
 * Structural violation fixtures (RL-070 negative-proof discipline).
 *
 * One VIRTUAL violating file per STRUCTURAL lock. These files are never
 * written to the repository: they exist only in memory and are handed to
 * the scanners when the matching lock's violation fixture is toggled on
 * via ROAMLINK_CONFORMANCE_VIOLATION=<LOCK-ID>. The toggled scan then finds
 * the violation and the suite goes RED - the executable demonstration that
 * each structural suite fails when the tree actually violates its lock.
 *
 * Credential-bearing fixture content is ASSEMBLED at runtime from split
 * parts so this source (and the commit) never contains complete secret
 * markers - the same discipline the repository's own pre-commit scanner
 * and @roamlink/retention use.
 */
import type { VirtualFile } from "./repo-scan.js";
import { violationEnabled } from "./violation-toggle.js";

/** A PEM private-key header, assembled so no literal appears in this source. */
const PEM_PRIVATE_KEY_HEADER = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");

/** The violating overlay for each structural lock id. */
export const VIOLATION_OVERLAYS: Readonly<Record<string, readonly VirtualFile[]>> = Object.freeze({
  /**
   * RL-LOCK-001: a competing connectivity lifecycle authority - a domain
   * package defining its own ADCOS-lifecycle-shaped state machine and
   * state vocabulary (superseding ADCOS semantics).
   */
  "RL-LOCK-001": Object.freeze([
    Object.freeze({
      path: "packages/domain-commerce/src/connectivity-lifecycle.ts",
      content: [
        "/** The shop's own view of connectivity lifecycle (a SECOND authority). */",
        "export const SHOP_CONNECTIVITY_STATES = [",
        '  "INTENT",',
        '  "OFFER_SELECTED",',
        '  "CONTRACT_ACTIVE",',
        '  "EXECUTION_ACTIVE",',
        '  "DELIVERY",',
        '  "ASSURED",',
        '  "USAGE_FINAL",',
        '  "SETTLEMENT_PENDING",',
        '  "SETTLED",',
        '  "DEGRADED",',
        '  "TERMINATED",',
        '  "EXPIRED",',
        '  "FAILED",',
        "] as const;",
        "",
        "export const SHOP_CONNECTIVITY_TRANSITIONS: Record<string, string[]> = {",
        '  INTENT: ["OFFER_SELECTED", "EXPIRED", "FAILED"],',
        '  OFFER_SELECTED: ["CONTRACT_ACTIVE", "TERMINATED", "FAILED"],',
        '  CONTRACT_ACTIVE: ["EXECUTION_ACTIVE", "DEGRADED", "TERMINATED"],',
        '  EXECUTION_ACTIVE: ["DELIVERY", "DEGRADED", "TERMINATED"],',
        '  DELIVERY: ["ASSURED", "DEGRADED", "TERMINATED"],',
        '  ASSURED: ["USAGE_FINAL", "DEGRADED"],',
        '  USAGE_FINAL: ["SETTLEMENT_PENDING"],',
        '  SETTLEMENT_PENDING: ["SETTLED", "FAILED"],',
        "};",
        "",
      ].join("\n"),
    }),
  ]),

  /**
   * RL-LOCK-002: an application module reaching past the one integration
   * boundary - the edge package importing the ADCOS contract package
   * directly instead of going through @roamlink/integration.
   */
  "RL-LOCK-002": Object.freeze([
    Object.freeze({
      path: "packages/edge/src/adcos-direct.ts",
      content: [
        "import type { AdcosClient } from \"@roamlink/adcos\";",
        "",
        "/** Talks to ADCOS directly from an application module (boundary bypass). */",
        "export async function probeAdcos(client: AdcosClient): Promise<unknown> {",
        "  return client.getApplication();",
        "}",
        "",
      ].join("\n"),
    }),
  ]),

  /**
   * RL-LOCK-006: a provider SDK silently imported by a core package -
   * provider-native state becoming RoamLink connectivity truth.
   */
  "RL-LOCK-006": Object.freeze([
    Object.freeze({
      path: "packages/domain-commerce/src/billing-gateway.ts",
      content: [
        'import Stripe from "stripe";',
        "",
        "/** Charges the card ourselves (provider state becomes our truth). */",
        "export function makeGateway(key: string): Stripe {",
        "  return new Stripe(key);",
        "}",
        "",
      ].join("\n"),
    }),
  ]),

  /**
   * RL-LOCK-012: an AI SDK imported by a domain package - the supply-chain
   * shape of an AI component that could outgrow its advisory role.
   */
  "RL-LOCK-012": Object.freeze([
    Object.freeze({
      path: "packages/domain-experience/src/ai-advisor.ts",
      content: [
        'import OpenAI from "openai";',
        "",
        "/** The advisor that proposes (and might one day authorize) preferences. */",
        "export function makeAdvisor(apiKey: string): OpenAI {",
        "  return new OpenAI({ apiKey });",
        "}",
        "",
      ].join("\n"),
    }),
  ]),

  /**
   * RL-LOCK-013: a hidden provider-SDK dependency in a core package's
   * manifest (the declared-dependency half of the leakage lock).
   */
  "RL-LOCK-013": Object.freeze([
    Object.freeze({
      path: "packages/domain-commerce/package.json",
      content: JSON.stringify(
        {
          name: "@roamlink/domain-commerce",
          version: "0.1.0",
          private: true,
          type: "module",
          engines: { node: ">=22.0.0" },
          sideEffects: false,
          exports: { ".": "./src/index.ts" },
          main: "./src/index.ts",
          types: "./src/index.ts",
          scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run" },
          dependencies: {
            "@roamlink/contracts": "workspace:*",
            "@roamlink/persistence": "workspace:*",
            stripe: "^14.0.0",
          },
          devDependencies: {
            "@types/node": "^22.10.0",
            eslint: "^9.17.0",
            typescript: "^5.7.2",
            vitest: "^3.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    }),
  ]),

  /**
   * RL-LOCK-016: literal credential material committed into a production
   * source file (the committed-secret half of the no-leakage lock).
   */
  "RL-LOCK-016": Object.freeze([
    Object.freeze({
      path: "packages/projections/src/credentials.ts",
      content: [
        "/** Deployment keys (committed - the violation). */",
        `export const ADCOS_SIGNING_KEY = ${JSON.stringify(PEM_PRIVATE_KEY_HEADER)};`,
        "export const ADCOS_SIGNING_KEY_BODY =",
        '  "MIIEpAIBAAKCAQEA1b4ZV7pVHYlF0C2mZ8sQ9dR3xKwLnO7gPqEaTt5uJcXhN2vB6y";',
        "",
      ].join("\n"),
    }),
  ]),

  /**
   * RL-LOCK-019: a sibling-authority dependency - the notifications
   * package depending on the commerce domain (two workers, one authority
   * stream: the frozen ownership rule broken).
   */
  "RL-LOCK-019": Object.freeze([
    Object.freeze({
      path: "packages/notifications/package.json",
      content: JSON.stringify(
        {
          name: "@roamlink/notifications",
          version: "0.1.0",
          private: true,
          type: "module",
          engines: { node: ">=22.0.0" },
          sideEffects: false,
          exports: { ".": "./src/index.ts" },
          main: "./src/index.ts",
          types: "./src/index.ts",
          scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run" },
          dependencies: {
            "@roamlink/contracts": "workspace:*",
            "@roamlink/domain-commerce": "workspace:*",
            "@roamlink/persistence": "workspace:*",
          },
          devDependencies: {
            "@roamlink/testkit": "workspace:*",
            "@types/node": "^22.10.0",
            eslint: "^9.17.0",
            typescript: "^5.7.2",
            vitest: "^3.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    }),
  ]),
});

/** The overlay for `lockId` when its violation fixture is toggled on. */
export function overlayFor(lockId: string): readonly VirtualFile[] {
  return violationEnabled(lockId) ? (VIOLATION_OVERLAYS[lockId] ?? []) : [];
}
