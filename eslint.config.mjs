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
      // shadcn primitives are vendored from upstream; treat as third-party
      "src/renderer/src/components/ui/**",
    ],
  },
  // Final layer: silence any ESLint rules that would conflict with Prettier
  // even after stylistic:false (e.g. rules that come from plugin presets).
  prettier
)
