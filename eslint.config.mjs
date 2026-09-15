import { roamlinkEslintBase } from "./eslint.config.base.mjs";

/**
 * Root ESLint config: applies the shared RoamLink base to repository-level
 * scripts (scripts/**) that are not owned by a workspace package. Workspace
 * packages have their own eslint.config.mjs extending the same base.
 *
 * scripts/check-architecture.mjs is the frozen orchestrator-owned gate; it is
 * excluded here and must not be edited by workers.
 */
export default [
  ...roamlinkEslintBase(),
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "scripts/check-architecture.mjs",
    ],
  },
];
