import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GrantStore } from "./grant-store"
import {
  computeTriggerMigrationNotice,
  loadTriggerMigrationNotice,
} from "./trigger-migration-notice"

const identity = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}

describe("trigger migration notice", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "trigger-migration-notice-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("flags a plugin with an agent-trigger and pre-existing grants as affected", async () => {
    const grants = new GrantStore(path.join(dir, "grants.json"))
    await grants.grant(identity, "network:https", "user")
    const state = await computeTriggerMigrationNotice({
      grants,
      pluginsWithAgentTriggers: [{ identity, triggerId: "poll-inbox" }],
    })
    expect(state.affectedTriggers).toEqual([
      { pluginId: "com.synapse.github-inbox", triggerId: "poll-inbox" },
    ])
  })

  it("does not flag a plugin with no pre-existing grants (fresh install)", async () => {
    const grants = new GrantStore(path.join(dir, "grants.json"))
    const state = await computeTriggerMigrationNotice({
      grants,
      pluginsWithAgentTriggers: [{ identity, triggerId: "poll-inbox" }],
    })
    expect(state.affectedTriggers).toEqual([])
  })

  it("loadTriggerMigrationNotice computes once and persists, never recomputing", async () => {
    const grants = new GrantStore(path.join(dir, "grants.json"))
    await grants.grant(identity, "network:https", "user")
    const noticeFilePath = path.join(dir, "trigger-migration-notice.json")

    const first = await loadTriggerMigrationNotice({
      noticeFilePath,
      instanceStoreFileExists: async () => false,
      grants,
      pluginsWithAgentTriggers: () => [{ identity, triggerId: "poll-inbox" }],
    })
    expect(first.affectedTriggers).toHaveLength(1)

    const second = await loadTriggerMigrationNotice({
      noticeFilePath,
      instanceStoreFileExists: async () => true,
      grants,
      pluginsWithAgentTriggers: () => [],
    })
    expect(second.affectedTriggers).toEqual(first.affectedTriggers)
  })
})
