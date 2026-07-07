import { resolve } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

// Eval runner config: includes ONLY *.eval.ts (kept out of the default `pnpm test`
// by the exclude in vitest.config.ts). Keyless — runs T0 corpora and writes a
// scorecard; a gated failure fails the process (and thus CI).
export default defineConfig({
  resolve: {
    alias: {
      "@synapse/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      "@synapse/plugin-manifest": resolve(__dirname, "packages/plugin-manifest/src/index.ts"),
      electron: resolve(__dirname, "__mocks__/electron.ts"),
    },
  },
  test: {
    include: ["src/main/ai/eval/**/*.eval.ts"],
    exclude: [...configDefaults.exclude],
    environment: "node",
    globals: false,
  },
})
