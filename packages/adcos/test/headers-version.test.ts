import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADCOS_API_VERSION,
  ADCOS_REQUEST_HEADER_NAMES,
  type AdcosMutationRequestHeaders,
  type AdcosRequiredRequestHeaders,
} from "../src/index.js";
import {
  ADCOS_API_VERSION_DEFAULT,
  SUPPORTED_ADCOS_API_VERSIONS,
  parseIdempotencyKey,
} from "@roamlink/contracts";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PKG_DIR, "src");

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("ADCOS request headers (RL-030)", () => {
  it("header name constants are exactly the documented v2 names", () => {
    expect(ADCOS_REQUEST_HEADER_NAMES.apiVersion).toBe("X-ADCOS-API-Version");
    expect(ADCOS_REQUEST_HEADER_NAMES.application).toBe("X-ADCOS-Application");
    expect(ADCOS_REQUEST_HEADER_NAMES.credential).toBe("X-ADCOS-Credential");
    expect(ADCOS_REQUEST_HEADER_NAMES.idempotencyKey).toBe("X-ADCOS-Idempotency-Key");
  });

  it("the typed mutation header record cannot be built without the idempotency key (compile-time, RL-LOCK-014)", () => {
    // Compile-time exhaustiveness of the typed header records: these
    // assignments only typecheck with exactly the required members.
    const required: AdcosRequiredRequestHeaders = {
      "X-ADCOS-API-Version": ADCOS_API_VERSION,
      "X-ADCOS-Application": "roamlink-api",
      "X-ADCOS-Credential": "credential-value",
    };
    const mutation: AdcosMutationRequestHeaders = {
      ...required,
      "X-ADCOS-Idempotency-Key": parseIdempotencyKey("idem-1"),
    };
    expect(Object.keys(required).sort()).toEqual([
      "X-ADCOS-API-Version",
      "X-ADCOS-Application",
      "X-ADCOS-Credential",
    ]);
    expect(Object.keys(mutation)).toHaveLength(4);
    expect(mutation["X-ADCOS-Idempotency-Key"]).toBe("idem-1");
  });
});

describe("version pin single-site assertion (RL-030, RL-LOCK-017)", () => {
  it("the pin is the 2.0 line", () => {
    expect(ADCOS_API_VERSION).toBe("2.0");
  });

  it("is defined in exactly one place (version.ts) and referenced elsewhere", () => {
    const sources = listTsFiles(SRC_DIR);
    expect(sources.length).toBeGreaterThan(5);
    const definitionSites: string[] = [];
    const literalSites: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      if (/ADCOS_API_VERSION\s*:\s*AdcosApiVersion\s*=/.test(source)) {
        definitionSites.push(file);
      }
      // the "2.0" literal may exist ONLY in version.ts (the single site)
      if (file !== join(SRC_DIR, "version.ts") && /"2\.0"/.test(source)) {
        literalSites.push(file);
      }
    }
    expect(definitionSites).toEqual([join(SRC_DIR, "version.ts")]);
    expect(literalSites).toEqual([]);
  });

  it("agrees with the @roamlink/contracts supported-version pin (no drift)", () => {
    expect(SUPPORTED_ADCOS_API_VERSIONS).toContain(ADCOS_API_VERSION);
    expect(ADCOS_API_VERSION_DEFAULT).toBe(ADCOS_API_VERSION);
  });
});
