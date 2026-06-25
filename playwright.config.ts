import { defineConfig } from "@playwright/test"

// Local / opt-in Electron smoke. Not part of the CI gate (Electron E2E on
// Windows CI is flaky) — run with `pnpm test:e2e`, which builds first.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
})
