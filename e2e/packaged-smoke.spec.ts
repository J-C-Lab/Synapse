import { expect, test } from "@playwright/test"
import {
  assertNoShellDiagnostics,
  assertPackagedHostSupported,
  assertProcessAliveAfterReadiness,
  awaitShellReadiness,
  launchSynapse,
} from "./electron-app-helpers"

// Packaged readiness proof for S11 Checkpoint R. Launches the ACTUAL
// electron-builder unpacked binary (release/win-unpacked/Synapse.exe, passed
// via SYNAPSE_PACKAGED_EXE by `pnpm test:e2e:packaged`) — the only artifact the
// release profile ships. Unlike smoke.spec.ts (unpacked repo root), here
// `app.isPackaged === true`, which is exactly what MCP onboarding requires.
//
// Windows-only: fail immediately (never skip) on any other host, and fail
// (never skip) when SYNAPSE_PACKAGED_EXE is absent — a missing packaged build
// must not masquerade as a passing run.

test.beforeAll(() => {
  assertPackagedHostSupported()
})

test("packaged shell is ready, alive, and diagnostically clean", async () => {
  const launched = await launchSynapse({ mode: "packaged" })
  try {
    const { shell, settings } = await awaitShellReadiness(launched, { mode: "packaged" })

    expect(settings).toHaveProperty("hotkey")
    expect(settings).toHaveProperty("themeMode")

    // Liveness AFTER readiness — a shell that renders then dies must fail.
    await assertProcessAliveAfterReadiness(launched)

    // No did-fail-load / preload-error / render-process-gone / pageerror /
    // crash / console.error touched the main shell.
    await assertNoShellDiagnostics(launched, shell)
  } finally {
    await launched.dispose()
  }
})

test("packaged MCP stdio handshake returns numeric tool/resource counts", async () => {
  const launched = await launchSynapse({ mode: "packaged" })
  try {
    const { shell } = await awaitShellReadiness(launched, { mode: "packaged" })

    // Drives the real preload bridge → mcp-onboarding:test-connection, which
    // spawns packaged `Synapse.exe --mcp-stdio` (re-exec'd as plain Node via
    // ELECTRON_RUN_AS_NODE=1), performs initialize + tools/list +
    // resources/list, and cleans up the child. Zero counts are valid — the
    // proof is that the handshake completed and returned numbers.
    const result = await shell.evaluate(() =>
      (
        window as unknown as {
          electronAPI: {
            testMcpOnboardingConnection: (
              workspaceId: string
            ) => Promise<{ toolCount: number; resourceCount: number }>
          }
        }
      ).electronAPI.testMcpOnboardingConnection("default")
    )

    expect(typeof result.toolCount).toBe("number")
    expect(typeof result.resourceCount).toBe("number")
    expect(result.toolCount).toBeGreaterThanOrEqual(0)
    expect(result.resourceCount).toBeGreaterThanOrEqual(0)

    await assertNoShellDiagnostics(launched, shell)
  } finally {
    await launched.dispose()
  }
})
