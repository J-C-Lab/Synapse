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
      // Stub Electron when running unit tests outside of Electron runtime.
      electron: resolve(__dirname, "__mocks__/electron.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json"],
      reportsDirectory: "coverage",
      include: [
        "src/main/launcher/{scan-start-menu,scan-uwp,search}.ts",
        "src/main/protocol/resolve-static-path.ts",
        "src/main/settings/settings.ts",
        "src/renderer/src/lib/utils.ts",
      ],
      exclude: [
        "src/renderer/src/components/ui/**",
        "src/main/index.ts",
        "src/preload/index.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 60,
        branches: 60,
      },
    },
  },
})
