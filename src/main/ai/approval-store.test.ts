import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApprovalStore } from "./approval-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ai-approvals-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(): ApprovalStore {
  return new ApprovalStore(path.join(dir, "approvals.json"))
}

describe("approvalStore", () => {
  it("persists and reads back allowed tools across instances", async () => {
    const file = path.join(dir, "approvals.json")
    const a = new ApprovalStore(file)
    await a.add("com.x/a")
    await a.add("mcp:srv/b")
    await a.add("com.x/a") // duplicate is a no-op

    expect((await new ApprovalStore(file).list()).sort()).toEqual(["com.x/a", "mcp:srv/b"])
  })

  it("removes an allowed tool", async () => {
    const s = store()
    await s.add("com.x/a")
    await s.remove("com.x/a")
    await s.remove("missing") // no-op
    expect(await s.list()).toEqual([])
  })

  it("ignores malformed persisted data", async () => {
    const file = path.join(dir, "approvals.json")
    await fs.writeFile(file, JSON.stringify({ alwaysAllow: ["ok", 5, null] }), "utf-8")
    expect(await new ApprovalStore(file).list()).toEqual(["ok"])
  })
})
