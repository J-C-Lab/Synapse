import { defineConfig } from "@playwright/test"

// Local / opt-in Electron smoke. Not part of the CI gate for the development
// project (Electron E2E on Windows CI is flaky). Three independent projects:
//
//  - `development` runs the ordinary E2E files against the unpacked repo root
//    and explicitly EXCLUDES packaged-smoke.spec.ts and profile-compat.spec.ts,
//    so `pnpm test:e2e` never needs a packaged build or the two explicit
//    profile-compat executables.
//  - `packaged` matches ONLY packaged-smoke.spec.ts and requires
//    SYNAPSE_PACKAGED_EXE (release/win-unpacked/Synapse.exe). Run via
//    `pnpm test:e2e:packaged` after `pnpm electron:build:win`.
//  - `profile-compat` matches ONLY profile-compat.spec.ts and requires
//    SYNAPSE_ELECTRON33_EXE (retained Checkpoint A win-unpacked Synapse.exe)
//    and SYNAPSE_ELECTRON43_EXE (this checkpoint's win-unpacked Synapse.exe),
//    both absolute existing paths on the same Windows host/OS user. Run via
//    `pnpm test:e2e:profile-compat` after setting both env vars.
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
      testIgnore: [/packaged-smoke\.spec\.ts/, /profile-compat\.spec\.ts/],
    },
    {
      name: "packaged",
      testMatch: /packaged-smoke\.spec\.ts/,
      // Packaged readiness spends ~12s in the liveness window plus a real MCP
      // stdio handshake (up to 10s), on top of launch + shell discovery.
      timeout: 120_000,
    },
    {
      name: "profile-compat",
      testMatch: /profile-compat\.spec\.ts/,
      // Four sequential packaged launches (33 original, 43 forward, 43
      // rollback-touch, 33 rollback) plus two recursive profile clones.
      timeout: 420_000,
    },
  ],
})
