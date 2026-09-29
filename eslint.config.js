import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".agent/**",
      ".codex/**",
      ".debug/**",
      "dist/**",
      "node_modules/**",
      // Byte-faithful research archive, retained with its original checksums.
      "prototypes/windows-contained-spawn/stdio/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
);
