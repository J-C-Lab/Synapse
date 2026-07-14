import { expect, test } from "@playwright/test"
import { awaitShellReadiness, launchSynapse } from "./electron-app-helpers"

// Whole-app smoke: launch the built Electron app (unpacked, from the repo
// root), confirm the renderer mounts, and confirm one real IPC round-trip.
// This is the integration path the unit suite (with mocked electron) cannot
// exercise. Local/opt-in — `pnpm test:e2e`. The packaged readiness proof lives
// in packaged-smoke.spec.ts.

test("launches, renders the shell, and round-trips IPC", async () => {
  const launched = await launchSynapse({ mode: "dev" })
  try {
    const { settings } = await awaitShellReadiness(launched, { mode: "dev" })
    expect(settings).toHaveProperty("hotkey")
    expect(settings).toHaveProperty("themeMode")
  } finally {
    await launched.dispose()
  }
})
