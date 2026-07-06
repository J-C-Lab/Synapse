import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AiSettingsStore } from "./ai-settings-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ai-settings-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(): AiSettingsStore {
  return new AiSettingsStore(path.join(dir, "settings.json"), "anthropic")
}

describe("aiSettingsStore", () => {
  it("defaults to the given provider with no models", async () => {
    expect(await store().get()).toEqual({
      activeProvider: "anthropic",
      models: {},
      budgetTokens: 0,
    })
  })

  it("persists active provider and per-provider model across instances", async () => {
    const file = path.join(dir, "settings.json")
    const a = new AiSettingsStore(file, "anthropic")
    await a.setActiveProvider("openai")
    await a.setModel("openai", "gpt-4.1")
    await a.setModel("anthropic", "claude-sonnet-4-6")

    const b = new AiSettingsStore(file, "anthropic")
    expect(await b.get()).toEqual({
      activeProvider: "openai",
      models: { openai: "gpt-4.1", anthropic: "claude-sonnet-4-6" },
      budgetTokens: 0,
    })
  })

  it("defaults the token budget to 0 (unlimited)", async () => {
    expect((await store().get()).budgetTokens).toBe(0)
  })

  it("persists the token budget across instances", async () => {
    const file = path.join(dir, "settings.json")
    const a = new AiSettingsStore(file, "anthropic")
    await a.setBudget(5000)

    const b = new AiSettingsStore(file, "anthropic")
    expect((await b.get()).budgetTokens).toBe(5000)
  })

  it("clamps a negative budget to 0", async () => {
    const file = path.join(dir, "settings.json")
    const a = new AiSettingsStore(file, "anthropic")
    await a.setBudget(-100)
    expect((await a.get()).budgetTokens).toBe(0)
  })

  it("defaults contextCompression to disabled and round-trips an update", async () => {
    const s = store()
    expect((await s.get()).contextCompression?.enabled ?? false).toBe(false)
    await s.setContextCompression({ enabled: true, thresholdTokens: 80_000 })
    expect((await s.get()).contextCompression).toEqual({ enabled: true, thresholdTokens: 80_000 })
  })

  it("leaves tool resilience unset by default", async () => {
    expect((await store().get()).toolResilience).toBeUndefined()
  })

  it("round-trips tool resilience settings and clamps invalid values", async () => {
    const file = path.join(dir, "settings.json")
    const a = new AiSettingsStore(file, "anthropic")
    await a.setToolResilience({ failureThreshold: 0, recoveryMs: -5, timeoutMs: -1 })

    const b = new AiSettingsStore(file, "anthropic")
    expect((await b.get()).toolResilience).toEqual({
      failureThreshold: 1,
      recoveryMs: 0,
      timeoutMs: 0,
    })
  })

  it("ignores malformed persisted data", async () => {
    const file = path.join(dir, "settings.json")
    await fs.writeFile(file, JSON.stringify({ activeProvider: 5, models: [1, 2] }), "utf-8")
    expect(await new AiSettingsStore(file, "anthropic").get()).toEqual({
      activeProvider: "anthropic",
      models: {},
      budgetTokens: 0,
    })
  })
})
