import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "tests/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      obsidianmd,
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
        },
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Codex", "codex", "Enter", "Esc", "Markdown", "Obsidian", "RefactorLens", "Refactor Lens"],
          acronyms: ["AI", "CLI", "Vault", "V1", "V2"],
        },
      ],
    },
  },
]);
