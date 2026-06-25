import { describe, expect, it } from "vitest"
import { DEFAULT_APP_NAME, resolveStdioUserDataDir } from "./stdio-paths"

describe("resolveStdioUserDataDir", () => {
  it("honors SYNAPSE_USER_DATA_DIR override above everything", () => {
    const dir = resolveStdioUserDataDir(
      { SYNAPSE_USER_DATA_DIR: "D:\\custom\\data", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
      "win32",
      "C:\\Users\\x"
    )
    expect(dir).toBe("D:\\custom\\data")
  })

  it("ignores a blank override", () => {
    const dir = resolveStdioUserDataDir({ SYNAPSE_USER_DATA_DIR: "   " }, "darwin", "/Users/x")
    expect(dir).toBe(`/Users/x/Library/Application Support/${DEFAULT_APP_NAME}`)
  })

  it("uses %APPDATA%/<appName> on Windows", () => {
    const dir = resolveStdioUserDataDir(
      { APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
      "win32",
      "C:\\Users\\x"
    )
    expect(dir).toBe("C:\\Users\\x\\AppData\\Roaming\\Synapse")
  })

  it("falls back to ~/AppData/Roaming when APPDATA is unset on Windows", () => {
    const dir = resolveStdioUserDataDir({}, "win32", "C:\\Users\\x")
    expect(dir).toBe("C:\\Users\\x\\AppData\\Roaming\\Synapse")
  })

  it("uses ~/Library/Application Support on macOS", () => {
    const dir = resolveStdioUserDataDir({}, "darwin", "/Users/x")
    expect(dir).toBe("/Users/x/Library/Application Support/Synapse")
  })

  it("uses $XDG_CONFIG_HOME on Linux when set, else ~/.config", () => {
    expect(resolveStdioUserDataDir({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/x")).toBe(
      "/cfg/Synapse"
    )
    expect(resolveStdioUserDataDir({}, "linux", "/home/x")).toBe("/home/x/.config/Synapse")
  })

  it("respects a custom app name", () => {
    const dir = resolveStdioUserDataDir({}, "linux", "/home/x", "synapse-dev")
    expect(dir).toBe("/home/x/.config/synapse-dev")
  })
})
