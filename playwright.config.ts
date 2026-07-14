import { defineConfig } from "@playwright/test"

// Local / opt-in Electron smoke. Not part of the CI gate for the development
// project (Electron E2E on Windows CI is flaky). Two independent projects:
//
//  - `development` runs the ordinary E2E files against the unpacked repo root
//    and explicitly EXCLUDES packaged-smoke.spec.ts, so `pnpm test:e2e` never
//    needs a packaged build.
//  - `packaged` matches ONLY packaged-smoke.spec.ts and requires
//    SYNAPSE_PACKAGED_EXE (release/win-unpacked/Synapse.exe). Run via
//    `pnpm test:e2e:packaged` after `pnpm electron:build:win`.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  projects: [
    {
      name: "development",
      testIgnore: /packaged-smoke\.spec\.ts/,
    },
    {
      name: "packaged",
      testMatch: /packaged-smoke\.spec\.ts/,
      // Packaged readiness spends ~12s in the liveness window plus a real MCP
      // stdio handshake (up to 10s), on top of launch + shell discovery.
      timeout: 120_000,
    },
  ],
})
