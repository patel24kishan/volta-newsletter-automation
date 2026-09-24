import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The review panel's script. It is never compiled or imported — it is read as a string and
    // inlined into the panel page (src/mcp/panel.ts) — so tsc never sees it and a typo there fails
    // silently inside the app's sandbox, with the panel simply not drawing. Linting it is the only
    // check there is. It runs in a browser frame, not Node, so it gets the browser globals.
    files: ["src/**/*.js"],
    languageOptions: {
      globals: { document: "readonly", globalThis: "readonly", URL: "readonly", setTimeout: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { ignores: ["node_modules/", "out/", "dist/"] },
);
