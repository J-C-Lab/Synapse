import type { ElectronApplication, Page } from "@playwright/test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

// Whole-app smoke: launch the built Electron app, confirm the renderer mounts,
// and confirm one real IPC round-trip. This is the integration path the unit
// suite (with mocked electron) cannot exercise. Local/opt-in — `pnpm test:e2e`.

test("launches, renders the shell, and round-trips IPC", async () => {
  const userDir = mkdtempSync(path.join(tmpdir(), "synapse-e2e-"))
  const app: ElectronApplication = await electron.launch({
    // The repo root holds package.json (main → out/main/index.js). A throwaway
    // user-data dir isolates the run from the real profile.
    args: [path.join(__dirname, ".."), `--user-data-dir=${userDir}`],
  })

  try {
    await app.firstWindow()

    // The same renderer bundle serves several windows that differ only by URL
    // hash (launcher = #search, floating ball = #floating-ball). The main shell
    // is the one with no hash.
    let shell: Page | undefined
    await expect
      .poll(
        () => {
          shell = app.windows().find((win) => new URL(win.url()).hash === "")
          return Boolean(shell)
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    // The main window starts hidden (tray app); reveal every window so the page
    // is attached and laid out before we assert.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.show()
    })

    await shell!.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })

    const settings = await shell!.evaluate(() =>
      (
        window as unknown as {
          electronAPI: { getSettings: () => Promise<Record<string, unknown>> }
        }
      ).electronAPI.getSettings()
    )
    expect(settings).toHaveProperty("hotkey")
    expect(settings).toHaveProperty("themeMode")
  } finally {
    await app.close()
    rmSync(userDir, { recursive: true, force: true })
  }
})
