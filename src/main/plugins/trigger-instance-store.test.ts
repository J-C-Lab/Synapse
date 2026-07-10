import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TriggerInstanceStore } from "./trigger-instance-store"

const identityA = {
  pluginId: "com.synapse.github-inbox",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:builtin",
  capabilityDeclarationHash: "hash-a",
}
const identityB = { ...identityA, capabilityDeclarationHash: "hash-b" }

describe("triggerInstanceStore", () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "trigger-instance-store-"))
    filePath = path.join(dir, "trigger-instances.json")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("create/list/remove round-trips a record", async () => {
    const store = new TriggerInstanceStore(filePath)
    const created = await store.create(identityA, "poll-inbox", "work")
    expect(created.identity).toEqual(identityA)
    expect(created.triggerId).toBe("poll-inbox")
    expect(created.workspaceId).toBe("work")
    expect(created.paused).toBe(false)

    const listed = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(listed).toEqual([created])

    const removed = await store.remove(created.id)
    expect(removed).toEqual(created)
    expect(await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")).toEqual([])
  })

  it("remove() returns undefined for an unknown id", async () => {
    const store = new TriggerInstanceStore(filePath)
    expect(await store.remove("nope")).toBeUndefined()
  })

  it("listForTrigger scopes to exactly the requested plugin+trigger", async () => {
    const store = new TriggerInstanceStore(filePath)
    await store.create(identityA, "poll-inbox", "work")
    await store.create(identityA, "other-trigger", "work")
    const listed = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(listed).toHaveLength(1)
    expect(listed[0].triggerId).toBe("poll-inbox")
  })

  it("create() throws on a duplicate (pluginId, triggerId, workspaceId) triple", async () => {
    const store = new TriggerInstanceStore(filePath)
    await store.create(identityA, "poll-inbox", "work")
    await expect(store.create(identityA, "poll-inbox", "work")).rejects.toThrow()
  })

  it("create() throws on a duplicate triple even when the existing record is stale", async () => {
    const store = new TriggerInstanceStore(filePath)
    await store.create(identityA, "poll-inbox", "work")
    // Same triple, different identity (simulating a plugin update) — still a duplicate.
    await expect(store.create(identityB, "poll-inbox", "work")).rejects.toThrow()
  })

  it("serializes concurrent create() calls for the same triple — only one wins", async () => {
    const store = new TriggerInstanceStore(filePath)
    const results = await Promise.allSettled([
      store.create(identityA, "poll-inbox", "work"),
      store.create(identityA, "poll-inbox", "work"),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })

  it("reactivate() updates identity and throws for an unknown id", async () => {
    const store = new TriggerInstanceStore(filePath)
    const created = await store.create(identityA, "poll-inbox", "work")
    const reactivated = await store.reactivate(created.id, identityB)
    expect(reactivated.identity).toEqual(identityB)
    await expect(store.reactivate("nope", identityB)).rejects.toThrow()
  })

  it("setPaused() toggles without deleting the record", async () => {
    const store = new TriggerInstanceStore(filePath)
    const created = await store.create(identityA, "poll-inbox", "work")
    await store.setPaused(created.id, true)
    const [paused] = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(paused.paused).toBe(true)
    await store.setPaused(created.id, false)
    const [resumed] = await store.listForTrigger("com.synapse.github-inbox", "poll-inbox")
    expect(resumed.paused).toBe(false)
  })

  it("removeForPlugin() removes every record for that plugin, leaves others untouched", async () => {
    const store = new TriggerInstanceStore(filePath)
    const other = { ...identityA, pluginId: "com.synapse.downloads-organizer" }
    await store.create(identityA, "poll-inbox", "work")
    await store.create(identityA, "poll-inbox", "personal")
    const untouched = await store.create(other, "downloads", "work")

    const removed = await store.removeForPlugin("com.synapse.github-inbox")
    expect(removed).toHaveLength(2)
    expect(await store.listAll()).toEqual([untouched])
  })
})
