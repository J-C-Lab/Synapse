import type { GrantIdentity } from "./grant-store"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"
import { sameIdentity } from "./grant-store"

// Whether a plugin's non-read-only tools (including destructiveHint ones)
// appear in the external MCP tools/list. This is orthogonal to GrantStore
// (a tool can be listed without being callable — readOnlyHint tools already
// work exactly that way today, listed regardless of grant state) and to
// externalMcpPreauthorized (whether a call still needs a live approval
// prompt). Keyed by the full GrantIdentity, not a bare pluginId, so a
// plugin update that rotates capabilityDeclarationHash does not silently
// carry over a prior exposure decision — same invariant GrantStore and
// externalMcpPreauthorized both already follow.

export interface McpExposureRecord {
  identity: GrantIdentity
  nonReadOnlyExposed: boolean
  updatedAt: number
}

interface McpExposureState {
  records: McpExposureRecord[]
}

export function mcpExposureFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugins", "mcp-exposure.json")
}

export class McpExposureStore {
  private state: McpExposureState | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async isNonReadOnlyExposed(identity: GrantIdentity): Promise<boolean> {
    const state = await this.load()
    const record = state.records.find((r) => sameIdentity(r.identity, identity))
    return record?.nonReadOnlyExposed === true
  }

  async setNonReadOnlyExposed(identity: GrantIdentity, value: boolean): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      state.records = state.records.filter((r) => !sameIdentity(r.identity, identity))
      state.records.push({ identity, nonReadOnlyExposed: value, updatedAt: this.now() })
      await this.persist(state)
    })
  }

  private async load(): Promise<McpExposureState> {
    if (!this.state) {
      const raw = await readJsonFile(this.filePath)
      this.state =
        raw && typeof raw === "object" && Array.isArray((raw as Partial<McpExposureState>).records)
          ? { records: (raw as McpExposureState).records }
          : { records: [] }
    }
    return this.state
  }

  private async persist(state: McpExposureState): Promise<void> {
    this.state = state
    await writeJsonFile(this.filePath, state)
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }
}
