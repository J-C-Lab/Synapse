import type { GrantIdentity, GrantStore } from "./grant-store"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

export interface TriggerMigrationNoticeState {
  affectedTriggers: Array<{ pluginId: string; triggerId: string }>
  dismissedAt?: number
}

export interface AgentTriggerDescriptor {
  identity: GrantIdentity
  triggerId: string
}

/** Computes which agent-triggers were "already running" pre-upgrade: their
 *  plugin already has at least one recorded capability grant, which can only
 *  be true for an install that went through this plugin's consent flow
 *  before this exact computation — never true for a fresh install enabling
 *  the plugin for the first time under the new, instance-based rules. */
export async function computeTriggerMigrationNotice(input: {
  grants: Pick<GrantStore, "list">
  pluginsWithAgentTriggers: AgentTriggerDescriptor[]
}): Promise<TriggerMigrationNoticeState> {
  const affectedTriggers: TriggerMigrationNoticeState["affectedTriggers"] = []
  for (const { identity, triggerId } of input.pluginsWithAgentTriggers) {
    const existingGrants = await input.grants.list(identity)
    if (existingGrants.length > 0) {
      affectedTriggers.push({ pluginId: identity.pluginId, triggerId })
    }
  }
  return { affectedTriggers }
}

/** Computed exactly once, gated on TriggerInstanceStore's own backing file
 *  never having existed — there is only ever one thing to migrate away
 *  from, so this doesn't need its own version counter. Every subsequent
 *  call reads the persisted result without recomputing. */
export async function loadTriggerMigrationNotice(input: {
  noticeFilePath: string
  instanceStoreFileExists: () => Promise<boolean>
  grants: Pick<GrantStore, "list">
  pluginsWithAgentTriggers: () => AgentTriggerDescriptor[]
}): Promise<TriggerMigrationNoticeState> {
  const existing = await readJsonFile(input.noticeFilePath)
  if (existing && typeof existing === "object") {
    return existing as TriggerMigrationNoticeState
  }
  if (await input.instanceStoreFileExists()) {
    const state: TriggerMigrationNoticeState = { affectedTriggers: [] }
    await writeJsonFile(input.noticeFilePath, state)
    return state
  }
  const state = await computeTriggerMigrationNotice({
    grants: input.grants,
    pluginsWithAgentTriggers: input.pluginsWithAgentTriggers(),
  })
  await writeJsonFile(input.noticeFilePath, state)
  return state
}

export async function dismissTriggerMigrationNotice(
  noticeFilePath: string,
  now: () => number = Date.now
): Promise<void> {
  const existing = await readJsonFile(noticeFilePath)
  const state: TriggerMigrationNoticeState =
    existing && typeof existing === "object"
      ? (existing as TriggerMigrationNoticeState)
      : { affectedTriggers: [] }
  state.dismissedAt = now()
  await writeJsonFile(noticeFilePath, state)
}
