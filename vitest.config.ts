import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@main": resolve(__dirname, "src/main"),
      "@preload": resolve(__dirname, "src/preload"),
      // Resolve the workspace SDK from source so tests do not require a prior
      // `pnpm build:sdk` and stay in sync with tsconfig.node.json paths.
      "@deskit/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      // Stub Electron when running unit tests outside of Electron runtime.
      electron: resolve(__dirname, "__mocks__/electron.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    css: false,
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
