import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pluginPreferenceFilePath, PluginPreferenceStore } from "./plugin-preferences"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-prefs-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("pluginPreferenceFilePath", () => {
  it("anchors the file at userData/plugin-preferences.json", () => {
    expect(pluginPreferenceFilePath("/userData")).toBe(
      path.join("/userData", "plugin-preferences.json")
    )
  })
})

describe("pluginPreferenceStore", () => {
  it("returns empty data when the file does not exist", async () => {
    const store = new PluginPreferenceStore(path.join(dir, "missing.json"))
    await store.load()
    expect(store.get("com.synapse.test")).toEqual({})
  })

  it("recovers to empty data when the file is corrupt JSON", async () => {
    const file = path.join(dir, "broken.json")
    await fs.writeFile(file, "{ not valid json", "utf-8")
    const store = new PluginPreferenceStore(file)
    await store.load()
    expect(store.get("com.synapse.test")).toEqual({})
  })

  it("ignores non-object entries during normalization", async () => {
    const file = path.join(dir, "mixed.json")
    await fs.writeFile(
      file,
      JSON.stringify({
        "com.synapse.ok": { unit: "ms" },
        "com.synapse.bad-array": [1, 2, 3],
        "com.synapse.bad-string": "nope",
      }),
      "utf-8"
    )
    const store = new PluginPreferenceStore(file)
    await store.load()
    expect(store.get("com.synapse.ok")).toEqual({ unit: "ms" })
    expect(store.get("com.synapse.bad-array")).toEqual({})
    expect(store.get("com.synapse.bad-string")).toEqual({})
  })

  it("persists set + delete and survives reload", async () => {
    const file = path.join(dir, "store.json")
    const store = new PluginPreferenceStore(file)
    await store.load()
    await store.set("com.synapse.test", "unit", "s")
    await store.set("com.synapse.test", "limit", 10)

    const reopened = new PluginPreferenceStore(file)
    await reopened.load()
    expect(reopened.get("com.synapse.test")).toEqual({ unit: "s", limit: 10 })

    await reopened.set("com.synapse.test", "limit", undefined)
    expect(reopened.get("com.synapse.test")).toEqual({ unit: "s" })
  })

  it("delete(pluginId) drops the whole plugin from the file", async () => {
    const file = path.join(dir, "store.json")
    const store = new PluginPreferenceStore(file)
    await store.load()
    await store.set("com.synapse.a", "x", 1)
    await store.set("com.synapse.b", "y", 2)
    await store.delete("com.synapse.a")

    const reopened = new PluginPreferenceStore(file)
    await reopened.load()
    expect(reopened.get("com.synapse.a")).toEqual({})
    expect(reopened.get("com.synapse.b")).toEqual({ y: 2 })
  })

  it("throws when used before load", () => {
    const store = new PluginPreferenceStore(path.join(dir, "unused.json"))
    expect(() => store.get("com.synapse.test")).toThrow(/must be loaded/)
  })
})
