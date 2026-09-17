import { roamlinkEslintBase } from "../../eslint.config.base.mjs";

/**
 * The release-gates suite lints its own machinery tests; the committed
 * FIXTURE trees (fixtures/**) are intentionally-shaped repository stand-ins
 * (pseudo-packages, canned documents) and are excluded from linting — they
 * are test data, not product code.
 */
export default [
  ...roamlinkEslintBase(),
  {
    ignores: ["**/node_modules/**", "fixtures/**"],
  },
];
