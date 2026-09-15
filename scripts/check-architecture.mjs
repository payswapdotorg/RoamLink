import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const required = [
  "README.md",
  "AGENTS.md",
  "spec/architecture.md",
  "spec/architecture-lock.md",
  "spec/authority-model.md",
  "spec/adcos-integration.md",
  "spec/work-items.md",
  "spec/dependency-graph.md",
  "spec/definition-of-done.md",
  "spec/orchestrator.md"
];

const missing = required.filter((file) => !existsSync(file));
if (missing.length) {
  console.error("Missing required architecture files:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const lock = readFileSync("spec/architecture-lock.md", "utf8");
const forbidden = [
  "second authority",
  "duplicate session authority",
  "duplicate path",
  "payment is delivery"
];

for (const phrase of forbidden) {
  if (lock.toLowerCase().includes(phrase) === false) {
    console.error(`Architecture lock sanity check failed: missing phrase '${phrase}'`);
    process.exit(1);
  }
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const forbiddenImports = [
  /from\s+["'].*adc\-?os\/.*["']/i,
  /from\s+["'].*@adcos\/.*["']/i
];
for (const file of walk("apps").concat(walk("packages"), walk("services"))) {
  if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const pattern of forbiddenImports) {
    if (pattern.test(source) && !file.includes(`${join("packages", "adcos")}`)) {
      console.error(`Forbidden ADCOS internal import pattern in ${file}`);
      process.exit(1);
    }
  }
}

console.log("RoamLink architecture checks passed.");
