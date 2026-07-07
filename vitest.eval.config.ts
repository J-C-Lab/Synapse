import { configDefaults, defineConfig } from "vitest/config"
import { workspaceAliases } from "./vitest.shared-aliases"

// Eval runner config: includes ONLY *.eval.ts (kept out of the default `pnpm test`
// by the exclude in vitest.config.ts). Keyless — runs T0 corpora and writes a
// scorecard; a gated failure fails the process (and thus CI).
export default defineConfig({
  resolve: {
    // Shared with vitest.config.ts (vitest.shared-aliases.ts) so a new workspace
    // alias only needs to be added in one place.
    alias: workspaceAliases,
  },
  test: {
    include: ["src/main/ai/eval/**/*.eval.ts"],
    exclude: [...configDefaults.exclude],
    environment: "node",
    globals: false,
  },
})
