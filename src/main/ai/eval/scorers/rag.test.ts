import type { RagFixture } from "./rag"
import { describe, expect, it } from "vitest"
import { scoreRag } from "./rag"

const fixture: RagFixture = {
  id: "recall-basic",
  title: "keyword query recalls the matching fact",
  tier: "T1",
  tags: ["rag"],
  seed: [
    {
      id: "s1",
      text: "The deploy script lives at scripts/release.sh",
      scope: { visibility: "workspace", workspaceId: "work" },
    },
    { id: "s2", text: "Cats are mammals", scope: { visibility: "workspace", workspaceId: "work" } },
    {
      id: "s3",
      text: "Secret in personal space",
      scope: { visibility: "workspace", workspaceId: "personal" },
    },
  ],
  query: "deploy script path",
  askedInWorkspace: "work",
  relevantIds: ["s1"],
  thresholds: { precisionAt3: 0.3, recall: 1, scopeIsolation: 1 },
}

describe("scoreRag", () => {
  it("recalls the relevant entry and isolates other workspaces", async () => {
    const r = await scoreRag(fixture)
    expect(r.passed).toBe(true)
    expect(r.metrics?.scopeIsolation).toBe(1)
    expect(r.metrics?.recall).toBe(1)
  })

  it("fails and is gated if a foreign-workspace entry leaks", async () => {
    // A query that also keyword-matches the personal entry must still not return it.
    const leaky = { ...fixture, id: "leak", query: "secret script", relevantIds: ["s1"] }
    const r = await scoreRag(leaky)
    expect(r.metrics?.scopeIsolation).toBe(1) // isolation holds regardless of query
    expect(r.gated).toBe(true)
  })
})
