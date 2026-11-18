import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import eslintConfigPrettier from "eslint-config-prettier/flat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  eslintConfigPrettier,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      // Generated reports (see .gitignore).
      "reports/**",
      "next-env.d.ts",
      // Agent worktrees are created under .claude/worktrees/, i.e. INSIDE the
      // repo. They are gitignored, but eslint does not read .gitignore — so a
      // full-repo sweep walks straight into another branch's working copy and
      // lints code that is not on this branch at all. `.husky/pre-push` runs
      // `pnpm lint && pnpm typecheck` over everything, so without this a push
      // from the main checkout fails on errors belonging to a parallel task.
      ".claude/**",
    ],
  },
];

export default eslintConfig;
