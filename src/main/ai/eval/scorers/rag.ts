import type { MemoryScope } from "../../memory/memory-store"
import type { FixtureMeta, ScoreResult } from "../fixture-types"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { MemoryService } from "../../memory/memory-service"
import { MemoryStore } from "../../memory/memory-store"
import { precisionAtK, recall } from "../metrics/retrieval"

// Corpus C: drives the real MemoryService/MemoryStore (keyless — BM25 keyword
// recall only, per memory-service.ts's fallback when no embedder is available)
// to prove two things at once: retrieval quality (precision/recall against
// ground-truth ids) and the cross-workspace scope-isolation invariant that
// guards the P4 workspace-binding boundary — a query asked in one workspace
// must never surface another workspace's entries, even if the wording matches.

export interface RagFixture extends FixtureMeta {
  seed: { id: string; text: string; scope: MemoryScope }[]
  query: string
  askedInWorkspace: string
  relevantIds: string[]
  thresholds: { precisionAt3: number; recall: number; scopeIsolation: number }
  /** Optional keyed-judge metadata consumed by Plan 4; ignored by keyless scoring. */
  t2?: {
    expectedAnswerContains: string
    answer?: string
  }
}

interface RetrievalMetrics extends Record<string, number> {
  precisionAt3: number
  recall: number
  scopeIsolation: number
}

export async function scoreRag(fixture: RagFixture): Promise<ScoreResult> {
  const retrievedFixtureIds = await retrieve(fixture)
  const metrics = scoreRetrieval(fixture, retrievedFixtureIds)
  const detail = diffMetrics(fixture, metrics)
  return {
    id: fixture.id,
    tier: fixture.tier,
    tags: fixture.tags,
    passed: detail === undefined,
    gated: true,
    detail,
    metrics,
  }
}

/** A hit annotated with its fixture id (if seeded) and whether it crosses workspace scope. */
interface TaggedHit {
  fixtureId: string | undefined
  crossesWorkspace: boolean
}

/**
 * Seeds a fresh keyless MemoryService with the fixture's data and runs the real
 * search. Runs once per fixture on every `pnpm eval` invocation (i.e. every CI
 * run), so the temp dir is always removed before returning — never left behind
 * for a CI runner or dev machine to accumulate across repeated runs.
 */
async function retrieve(fixture: RagFixture): Promise<TaggedHit[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-rag-"))
  try {
    // Keyless embedder → BM25-only recall (memory-service.ts's safeEmbed fallback).
    const service = new MemoryService(new MemoryStore(path.join(dir, "memory.json")), {
      embed: async () => null,
    })

    const idMap = new Map<string, string>() // stored id -> fixture id
    for (const s of fixture.seed) {
      const entry = await service.save({ text: s.text, scope: s.scope })
      idMap.set(entry.id, s.id)
    }

    const hits = await service.search(fixture.query, 10, {
      workspaceId: fixture.askedInWorkspace,
      includeGlobal: true,
    })

    return hits.map((h) => ({
      fixtureId: idMap.get(h.entry.id),
      crossesWorkspace:
        h.entry.scope.visibility === "workspace" &&
        h.entry.scope.workspaceId !== fixture.askedInWorkspace,
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Computes precision@3 / recall / scope isolation from tagged hits. */
function scoreRetrieval(fixture: RagFixture, hits: TaggedHit[]): RetrievalMetrics {
  const retrievedFixtureIds = hits
    .map((h) => h.fixtureId)
    .filter((x): x is string => x !== undefined)
  const leaked = hits.some((h) => h.crossesWorkspace)
  return {
    precisionAt3: precisionAtK(retrievedFixtureIds, fixture.relevantIds, 3),
    recall: recall(retrievedFixtureIds, fixture.relevantIds),
    scopeIsolation: leaked ? 0 : 1,
  }
}

/** Returns the first mismatch as a human-readable detail, or undefined if thresholds hold. */
function diffMetrics(fixture: RagFixture, metrics: RetrievalMetrics): string | undefined {
  const problems: string[] = []
  if (metrics.scopeIsolation < fixture.thresholds.scopeIsolation) {
    problems.push("scope isolation breached")
  }
  if (metrics.precisionAt3 < fixture.thresholds.precisionAt3) {
    problems.push(
      `precision@3 ${metrics.precisionAt3.toFixed(2)} < ${fixture.thresholds.precisionAt3}`
    )
  }
  if (metrics.recall < fixture.thresholds.recall) {
    problems.push(`recall ${metrics.recall.toFixed(2)} < ${fixture.thresholds.recall}`)
  }
  return problems.length ? problems.join("; ") : undefined
}
