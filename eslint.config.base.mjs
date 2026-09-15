/**
 * Shared ESLint flat-config factory for every RoamLink workspace package.
 *
 * Owned by the foundation (RL-001). Packages extend this by calling the
 * factory from their own `eslint.config.mjs`:
 *
 *   import { roamlinkEslintBase } from "../../eslint.config.base.mjs";
 *   export default roamlinkEslintBase();
 *
 * Rules kept intentionally small and dependency-free (no type-aware linting)
 * so `pnpm lint` stays fast and CI-safe.
 *
 * Notable policy encoded here:
 *  - "erasable TypeScript only": enums, non-global namespaces/modules and
 *    constructor parameter properties are banned so package sources stay
 *    runnable under Node's native type stripping (`--experimental-strip-types`,
 *    default on Node >= 22.18) without a build step.
 *  - unused identifiers must be prefixed with `_`.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export function roamlinkEslintBase() {
  return [
    {
      ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
    },
    js.configs.recommended,
    {
      languageOptions: {
        globals: { ...globals.node },
      },
    },
    ...tseslint.configs.recommended,
    {
      rules: {
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { prefer: "type-imports", fixStyle: "separate-type-imports" },
        ],
        "@typescript-eslint/no-non-null-assertion": "error",
        "no-restricted-syntax": [
          "error",
          {
            selector: "TSEnumDeclaration",
            message:
              "RoamLink packages use erasable TypeScript only. Replace enums with a const object plus a union type so sources stay runnable under Node type stripping.",
          },
          {
            selector: "TSModuleDeclaration[kind!='global']",
            message:
              "RoamLink packages use erasable TypeScript only. Namespaces/modules are banned; use ES modules instead.",
          },
          {
            selector: "TSParameterProperty",
            message:
              "Constructor parameter properties are not erasable. Assign fields explicitly in the constructor body.",
          },
        ],
      },
    },
  ];
}

export default roamlinkEslintBase;
