import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverPlugins } from "./plugin-discovery"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-plugins-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("discoverPlugins", () => {
  it("discovers builtin, user and dev plugins", async () => {
    const builtinDir = path.join(dir, "builtin")
    const userDir = path.join(dir, "user")
    const devPlugin = path.join(dir, "dev-plugin")
    const devFilePath = path.join(dir, "dev-plugins.json")

    await writePlugin(path.join(builtinDir, "timestamp"), "com.synapse.timestamp")
    await writePlugin(path.join(userDir, "notes"), "com.synapse.notes")
    await writePlugin(devPlugin, "com.synapse.dev")
    await fs.writeFile(devFilePath, JSON.stringify([{ path: devPlugin }]), "utf-8")

    const entries = await discoverPlugins({ builtinDir, userDir, devFilePath })
    expect(entries.map((entry) => [entry.pluginId, entry.source.kind, entry.status])).toEqual([
      ["com.synapse.timestamp", "builtin", "valid"],
      ["com.synapse.notes", "user", "valid"],
      ["com.synapse.dev", "dev", "valid"],
    ])
  })

  it("marks malformed plugin directories invalid without stopping discovery", async () => {
    const builtinDir = path.join(dir, "builtin")
    await writePlugin(path.join(builtinDir, "good"), "com.synapse.good")
    await fs.mkdir(path.join(builtinDir, "bad"), { recursive: true })
    await fs.writeFile(path.join(builtinDir, "bad", "synapse.json"), "{bad-json", "utf-8")

    const entries = await discoverPlugins({ builtinDir })
    expect(entries).toHaveLength(2)
    expect(entries.find((entry) => entry.pluginId === "com.synapse.good")?.status).toBe("valid")
    expect(entries.find((entry) => entry.status === "invalid")?.error).toContain("valid JSON")
  })

  it("ignores malformed dev plugin config without blocking other sources", async () => {
    const builtinDir = path.join(dir, "builtin")
    const devFilePath = path.join(dir, "dev-plugins.json")

    await writePlugin(path.join(builtinDir, "good"), "com.synapse.good")
    await fs.writeFile(devFilePath, "{bad-json", "utf-8")

    const entries = await discoverPlugins({ builtinDir, devFilePath })
    expect(entries.map((entry) => [entry.pluginId, entry.source.kind, entry.status])).toEqual([
      ["com.synapse.good", "builtin", "valid"],
    ])
  })

  it("uses builtin over user over dev when plugin ids conflict", async () => {
    const builtinDir = path.join(dir, "builtin")
    const userDir = path.join(dir, "user")
    const devPlugin = path.join(dir, "dev-plugin")
    const devFilePath = path.join(dir, "dev-plugins.json")

    await writePlugin(path.join(builtinDir, "shared"), "com.synapse.shared")
    await writePlugin(path.join(userDir, "shared"), "com.synapse.shared")
    await writePlugin(devPlugin, "com.synapse.shared")
    await fs.writeFile(devFilePath, JSON.stringify([devPlugin]), "utf-8")

    const entries = await discoverPlugins({ builtinDir, userDir, devFilePath })
    expect(entries.map((entry) => [entry.source.kind, entry.status, entry.shadowedBy])).toEqual([
      ["builtin", "valid", undefined],
      ["user", "shadowed", "builtin"],
      ["dev", "shadowed", "builtin"],
    ])
  })
})

async function writePlugin(pluginDir: string, id: string): Promise<void> {
  await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true })
  await fs.writeFile(
    path.join(pluginDir, "synapse.json"),
    JSON.stringify(
      {
        id,
        name: id,
        displayName: id,
        description: "test",
        version: "0.3.0",
        author: "Synapse",
        engines: { synapse: "^0.2.0" },
        main: "dist/index.js",
        contributes: { commands: [{ id: `${id.split(".").at(-1)}.run`, title: "Run" }] },
        permissions: [],
      },
      null,
      2
    ),
    "utf-8"
  )
}
