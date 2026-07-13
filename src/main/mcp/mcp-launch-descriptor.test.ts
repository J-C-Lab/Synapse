import { describe, expect, it } from "vitest"
import {
  buildMcpLaunchDescriptor,
  resolveMcpExecutablePath,
  serializeClaudeDesktopConfig,
} from "./mcp-launch-descriptor"

describe("resolveMcpExecutablePath", () => {
  it("returns process.env.APPIMAGE on Linux when set", () => {
    expect(resolveMcpExecutablePath("linux", { APPIMAGE: "/opt/Synapse.AppImage" })).toBe(
      "/opt/Synapse.AppImage"
    )
  })

  it("falls back to execPath on Linux when APPIMAGE is unset", () => {
    expect(resolveMcpExecutablePath("linux", {}, "/usr/bin/synapse")).toBe("/usr/bin/synapse")
  })

  it("returns execPath on Windows/macOS regardless of APPIMAGE", () => {
    expect(
      resolveMcpExecutablePath("win32", { APPIMAGE: "/opt/Synapse.AppImage" }, "C:\\Synapse.exe")
    ).toBe("C:\\Synapse.exe")
    expect(
      resolveMcpExecutablePath(
        "darwin",
        { APPIMAGE: "/opt/Synapse.AppImage" },
        "/Applications/Synapse.app"
      )
    ).toBe("/Applications/Synapse.app")
  })
})

describe("buildMcpLaunchDescriptor", () => {
  it("always includes SYNAPSE_MCP_WORKSPACE and SYNAPSE_USER_DATA_DIR", () => {
    const descriptor = buildMcpLaunchDescriptor(
      "work",
      "/home/user/.config/Synapse",
      "/usr/bin/synapse"
    )
    expect(descriptor).toEqual({
      command: "/usr/bin/synapse",
      args: ["--mcp-stdio"],
      env: {
        SYNAPSE_MCP_WORKSPACE: "work",
        SYNAPSE_USER_DATA_DIR: "/home/user/.config/Synapse",
      },
    })
  })
})

describe("serializeClaudeDesktopConfig", () => {
  it("derives the server key from workspaceId, not a separate parameter", () => {
    const descriptor = buildMcpLaunchDescriptor("work", "/data", "/usr/bin/synapse")
    const json = serializeClaudeDesktopConfig(descriptor, "work")
    const parsed = JSON.parse(json)
    expect(Object.keys(parsed.mcpServers)).toEqual(["synapse-work"])
    expect(parsed.mcpServers["synapse-work"]).toEqual(descriptor)
  })

  it("round-trips a Windows path with backslashes without corruption", () => {
    const descriptor = buildMcpLaunchDescriptor(
      "work",
      "C:\\Users\\alice\\AppData\\Roaming\\Synapse",
      "C:\\Program Files\\Synapse\\Synapse.exe"
    )
    const json = serializeClaudeDesktopConfig(descriptor, "work")
    const parsed = JSON.parse(json)
    expect(parsed.mcpServers["synapse-work"].command).toBe(
      "C:\\Program Files\\Synapse\\Synapse.exe"
    )
    expect(parsed.mcpServers["synapse-work"].env.SYNAPSE_USER_DATA_DIR).toBe(
      "C:\\Users\\alice\\AppData\\Roaming\\Synapse"
    )
  })
})
