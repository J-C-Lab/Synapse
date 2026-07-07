import { availableParallelism } from "node:os"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { configDefaults, defineConfig } from "vitest/config"
import { workspaceAliases } from "./vitest.shared-aliases"

// Cap worker count below the core count so CPU-heavy suites (pglite WASM,
// LAN TLS handshakes, vm wall-clock timeouts) keep enough scheduling headroom
// to stay deterministic when the whole suite runs in parallel.
const maxWorkers = Math.max(2, Math.floor(availableParallelism() * 0.7))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@main": resolve(__dirname, "src/main"),
      "@preload": resolve(__dirname, "src/preload"),
      // Resolve the workspace SDK from source so tests do not require a prior
      // `pnpm build:sdk` and stay in sync with tsconfig.node.json paths.
      ...workspaceAliases,
    },
  },
  test: {
    // The e2e/ suite is Playwright (its own runner) — keep it out of Vitest,
    // which would otherwise pick up *.spec.ts and choke on @playwright/test.
    exclude: [...configDefaults.exclude, "e2e/**", "**/*.eval.ts"],
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    maxWorkers,
    minWorkers: 1,
    // junit reporter writes a single XML file so the workflow can upload it
    // as the "test-results" artifact and feed it to publish-unit-test-result
    // for a PR comment. "default" keeps the terminal output local devs expect.
    reporters: ["default", "junit"],
    outputFile: {
      junit: "coverage/junit.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json"],
      reportsDirectory: "coverage",
      include: ["src/main/**/*.ts", "src/preload/**/*.ts", "src/renderer/src/**/*.{ts,tsx}"],
      exclude: [
        "src/renderer/src/components/ui/**",
        "src/main/index.ts",
        "src/preload/index.ts",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
      ],
    },
  },
})
