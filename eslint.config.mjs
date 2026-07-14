import antfu from "@antfu/eslint-config"
import prettier from "eslint-config-prettier"

// We delegate formatting to Prettier and use antfu only for code quality
// (unused imports, import sorting, hooks rules, etc.). Stylistic rules are
// disabled to avoid two formatters fighting over the same files.
export default antfu(
  {
    type: "app",
    stylistic: false,
    typescript: true,
    react: true,
    test: true, // enables eslint-plugin-vitest
    jsonc: true,
    yaml: true,
    markdown: false,
    ignores: [
      "out/**",
      "release/**",
      "coverage/**",
      "node_modules/**",
      "docs/**",
      // Sibling checkouts of this same repo (superpowers:using-git-worktrees)
      // — their source is a duplicate, not part of this checkout's program.
      ".worktrees/**",
      // shadcn primitives are vendored from upstream; treat as third-party
      "src/renderer/src/components/ui/**",
      // Scaffolder payload — shipped verbatim to generated plugin projects,
      // not part of this repo's source program.
      "packages/create-synapse-plugin/template/**",
    ],
  },
  // Main-process code logs through the structured logger (src/main/logging),
  // never raw console — that keeps output off stdout (the MCP-stdio invariant)
  // and structured/redacted. The logger module and the headless stdio entry are
  // the sanctioned places to touch process streams.
  {
    files: ["src/main/**/*.ts"],
    ignores: ["src/main/**/*.test.ts", "src/main/logging/**", "src/main/mcp/stdio-entry.ts"],
    rules: { "no-console": "error" },
  },
  // Final layer: silence any ESLint rules that would conflict with Prettier
  // even after stylistic:false (e.g. rules that come from plugin presets).
  prettier
)
