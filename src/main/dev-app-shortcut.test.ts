import { describe, expect, it } from "vitest"
import { buildShortcutScript, devShortcutPath } from "./dev-app-shortcut"

describe("devShortcutPath", () => {
  it("places the shortcut in the current user's Start Menu Programs folder", () => {
    const result = devShortcutPath("C:\\Users\\jackie\\AppData\\Roaming")
    expect(result).toBe(
      "C:\\Users\\jackie\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Synapse (Dev).lnk"
    )
  })
})

describe("buildShortcutScript", () => {
  const opts = {
    shortcutPath: "C:\\Start Menu\\Synapse (Dev).lnk",
    targetExe: "C:\\node_modules\\electron\\dist\\electron.exe",
    appDir: "D:\\Programs\\A My Code\\Synapse",
    iconPath: "D:\\Programs\\A My Code\\Synapse\\resources\\icon.ico",
    aumid: "com.synapse.desktop",
  }

  it("embeds every path and the AUMID in the generated script", () => {
    const script = buildShortcutScript(opts)
    expect(script).toContain(opts.shortcutPath)
    expect(script).toContain(opts.targetExe)
    expect(script).toContain(opts.appDir)
    expect(script).toContain(opts.iconPath)
    expect(script).toContain(opts.aumid)
  })

  it("creates the shortcut via WScript.Shell before stamping the AUMID", () => {
    const script = buildShortcutScript(opts)
    const createIndex = script.indexOf("WScript.Shell")
    const aumidIndex = script.indexOf(opts.aumid)
    expect(createIndex).toBeGreaterThan(-1)
    expect(aumidIndex).toBeGreaterThan(createIndex)
  })
})
