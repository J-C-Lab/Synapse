import { describe, expect, it } from "vitest"
import { suggestWorkspaceId } from "./execution-workspace-dialog"

describe("suggestWorkspaceId", () => {
  it("derives a slug from the folder name", () => {
    expect(suggestWorkspaceId("E:\\Projects\\Synapse", [])).toBe("Synapse")
  })

  it("avoids collisions with existing ids", () => {
    expect(suggestWorkspaceId("/tmp/Synapse", ["Synapse"])).toBe("Synapse-2")
  })
})
