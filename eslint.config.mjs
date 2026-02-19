import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["out/", "node_modules/", "scripts/", "*.mjs"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: "error",
    },
  }
);
