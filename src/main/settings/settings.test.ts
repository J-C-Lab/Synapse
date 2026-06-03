import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsFilePath,
} from "./settings"

describe("normalizeSettings", () => {
  it("returns defaults for unknown input", () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings)
    expect(normalizeSettings("nope")).toEqual(defaultSettings)
    expect(normalizeSettings({})).toEqual(defaultSettings)
  })

  it("keeps a valid hotkey and trims whitespace", () => {
    expect(normalizeSettings({ hotkey: "  Alt+Space  " })).toEqual({
      ...defaultSettings,
      hotkey: "Alt+Space",
    })
  })

  it("falls back to default when hotkey is blank", () => {
    expect(normalizeSettings({ hotkey: "   " })).toEqual(defaultSettings)
  })

  it("strips unknown fields", () => {
    expect(normalizeSettings({ hotkey: "Alt+K", evil: true })).toEqual({
      ...defaultSettings,
      hotkey: "Alt+K",
    })
  })

  it("accepts known theme modes and rejects others", () => {
    expect(normalizeSettings({ themeMode: "dark" })).toEqual({
      ...defaultSettings,
      themeMode: "dark",
    })
    expect(normalizeSettings({ themeMode: "neon" })).toEqual(defaultSettings)
  })

  it("accepts known accents and rejects others", () => {
    expect(normalizeSettings({ accent: "blue" })).toEqual({
      ...defaultSettings,
      accent: "blue",
    })
    expect(normalizeSettings({ accent: "puce" })).toEqual(defaultSettings)
  })

  it("normalizes floating ball settings", () => {
    expect(
      normalizeSettings({
        floatingBallEnabled: true,
        floatingBallFeatures: ["appLauncher", "floatingBall", "appLauncher", 42],
      })
    ).toEqual({
      ...defaultSettings,
      floatingBallEnabled: true,
      floatingBallFeatures: ["appLauncher"],
    })
  })

  it("normalizes the LAN discovery switch", () => {
    expect(normalizeSettings({ lanEnabled: true })).toEqual({
      ...defaultSettings,
      lanEnabled: true,
    })
    expect(normalizeSettings({ lanEnabled: "yes" })).toEqual(defaultSettings)
  })

  it("keeps a default floating ball feature when the configured list is empty", () => {
    expect(normalizeSettings({ floatingBallFeatures: ["floatingBall"] })).toEqual(defaultSettings)
  })
})

describe("loadSettings / saveSettings", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskit-settings-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("loads defaults when the file does not exist", async () => {
    const file = settingsFilePath(dir)
    const settings = await loadSettings(file)
    expect(settings).toEqual(defaultSettings)
  })

  it("round-trips through save + load", async () => {
    const file = settingsFilePath(dir)
    const written = { ...defaultSettings, hotkey: "Alt+Shift+P", themeMode: "dark" as const }
    await saveSettings(file, written)
    const settings = await loadSettings(file)
    expect(settings).toEqual(written)
  })

  it("normalizes a malformed file rather than throwing", async () => {
    const file = settingsFilePath(dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"hotkey": 42}', "utf-8")
    const settings = await loadSettings(file)
    expect(settings).toEqual(defaultSettings)
  })

  it("loads defaults when settings JSON is corrupted", async () => {
    const file = settingsFilePath(dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{not-json", "utf-8")
    const settings = await loadSettings(file)
    expect(settings).toEqual(defaultSettings)
  })
})
