import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Which provider is active and which model each provider uses. Plain JSON, no
// secrets (keys live in the encrypted AiCredentialStore). Persisted so the
// user's BYOK choice survives restarts.

export interface AiSettings {
  activeProvider: string
  /** Selected model per provider id. Falls back to the catalog default. */
  models: Record<string, string>
  /** Per-run cumulative token budget. 0 means unlimited. */
  budgetTokens: number
}

export function aiSettingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "settings.json")
}

export class AiSettingsStore {
  private settings: AiSettings | null = null

  constructor(
    private readonly filePath: string,
    private readonly defaultProvider: string
  ) {}

  async get(): Promise<AiSettings> {
    if (this.settings) return this.settings
    this.settings = normalize(await readJsonFile(this.filePath), this.defaultProvider)
    return this.settings
  }

  async setActiveProvider(providerId: string): Promise<void> {
    const settings = await this.get()
    await this.persist({ ...settings, activeProvider: providerId })
  }

  async setModel(providerId: string, model: string): Promise<void> {
    const settings = await this.get()
    await this.persist({
      ...settings,
      models: { ...settings.models, [providerId]: model },
    })
  }

  /** Set the per-run token budget. Negative values clamp to 0 (unlimited). */
  async setBudget(tokens: number): Promise<void> {
    const settings = await this.get()
    await this.persist({ ...settings, budgetTokens: Math.max(0, Math.floor(tokens)) })
  }

  private async persist(settings: AiSettings): Promise<void> {
    this.settings = settings
    await writeJsonFile(this.filePath, settings)
  }
}

function normalize(value: unknown, defaultProvider: string): AiSettings {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const models: Record<string, string> = {}
  if (v.models && typeof v.models === "object" && !Array.isArray(v.models)) {
    for (const [provider, model] of Object.entries(v.models as Record<string, unknown>)) {
      if (typeof model === "string") models[provider] = model
    }
  }
  const budgetTokens =
    typeof v.budgetTokens === "number" && Number.isFinite(v.budgetTokens) && v.budgetTokens > 0
      ? Math.floor(v.budgetTokens)
      : 0
  return {
    activeProvider: typeof v.activeProvider === "string" ? v.activeProvider : defaultProvider,
    models,
    budgetTokens,
  }
}
