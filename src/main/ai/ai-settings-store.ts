import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Which provider is active and which model each provider uses. Plain JSON, no
// secrets (keys live in the encrypted AiCredentialStore). Persisted so the
// user's BYOK choice survives restarts.

/** Per-tool circuit-breaker tuning. Absent → the built-in defaults apply. */
export interface ToolResilienceSettings {
  /** Consecutive infra failures that trip a tool's circuit open. */
  failureThreshold: number
  /** How long the circuit stays open before admitting a probe (ms). */
  recoveryMs: number
  /** Timeout for non-long-running tools (ms); 0 disables the timeout. */
  timeoutMs: number
}

export const DEFAULT_TOOL_RESILIENCE: ToolResilienceSettings = {
  failureThreshold: 5,
  recoveryMs: 60_000,
  timeoutMs: 30_000,
}

export interface AiSettings {
  activeProvider: string
  models: Record<string, string>
  budgetTokens: number
  contextCompression?: { enabled: boolean; thresholdTokens: number }
  toolResilience?: ToolResilienceSettings
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

  async setBudget(tokens: number): Promise<void> {
    const settings = await this.get()
    await this.persist({ ...settings, budgetTokens: Math.max(0, Math.floor(tokens)) })
  }

  async setContextCompression(value: { enabled: boolean; thresholdTokens: number }): Promise<void> {
    const settings = await this.get()
    const next = {
      enabled: value.enabled,
      thresholdTokens: Math.max(0, Math.floor(value.thresholdTokens)),
    }
    await this.persist({ ...settings, contextCompression: next })
  }

  async setToolResilience(value: ToolResilienceSettings): Promise<void> {
    const settings = await this.get()
    await this.persist({ ...settings, toolResilience: clampResilience(value) })
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
  let contextCompression: AiSettings["contextCompression"]
  if (
    v.contextCompression &&
    typeof v.contextCompression === "object" &&
    !Array.isArray(v.contextCompression)
  ) {
    const cc = v.contextCompression as Record<string, unknown>
    contextCompression = {
      enabled: cc.enabled === true,
      thresholdTokens:
        typeof cc.thresholdTokens === "number" && Number.isFinite(cc.thresholdTokens)
          ? Math.max(0, Math.floor(cc.thresholdTokens))
          : 0,
    }
  }
  let toolResilience: AiSettings["toolResilience"]
  if (
    v.toolResilience &&
    typeof v.toolResilience === "object" &&
    !Array.isArray(v.toolResilience)
  ) {
    const r = v.toolResilience as Record<string, unknown>
    toolResilience = clampResilience({
      failureThreshold: asNumber(r.failureThreshold, DEFAULT_TOOL_RESILIENCE.failureThreshold),
      recoveryMs: asNumber(r.recoveryMs, DEFAULT_TOOL_RESILIENCE.recoveryMs),
      timeoutMs: asNumber(r.timeoutMs, DEFAULT_TOOL_RESILIENCE.timeoutMs),
    })
  }
  return {
    activeProvider: typeof v.activeProvider === "string" ? v.activeProvider : defaultProvider,
    models,
    budgetTokens,
    ...(contextCompression !== undefined ? { contextCompression } : {}),
    ...(toolResilience !== undefined ? { toolResilience } : {}),
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/** failureThreshold ≥ 1; recovery/timeout ≥ 0 (0 timeout = disabled). */
function clampResilience(value: ToolResilienceSettings): ToolResilienceSettings {
  return {
    failureThreshold: Math.max(1, Math.floor(value.failureThreshold)),
    recoveryMs: Math.max(0, Math.floor(value.recoveryMs)),
    timeoutMs: Math.max(0, Math.floor(value.timeoutMs)),
  }
}
