import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "reports/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // A warning rather than an error: `any` is sometimes the honest type at a
      // boundary the framework does not control, and a build that fails on it
      // teaches people to write `as unknown as X` instead.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // A backend logs to stdout; that is what the log driver reads.
      "no-console": "off",
    },
  }
);
