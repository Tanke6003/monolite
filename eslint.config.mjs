import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // The CLI's templates are TypeScript for the *generated* project, not for
      // this repository: they import `@monolite/*` packages that are not
      // dependencies here and contain placeholders that are not valid syntax
      // until they are rendered.
      "**/templates/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    // Tests get the Jest globals and a looser hand with `any`: a fake collaborator
    // standing in for a driver is not worth a full type, and forcing one there
    // makes the test harder to read than the code it covers.
    files: ["**/tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  }
);
