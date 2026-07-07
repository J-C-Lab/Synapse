import type { ChatProvider } from "../providers/types"
// @vitest-environment node
import type { ScoreResult } from "./fixture-types"
import type { RagFixture } from "./scorers/rag"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { describe, expect, it } from "vitest"
import { AiCredentialStore } from "../credential-store"
import { MemoryService } from "../memory/memory-service"
import { MemoryStore } from "../memory/memory-store"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "../providers/catalog"
import { loadFixtures } from "./fixture-types"
import { judge } from "./judge"
import { buildScorecard, writeScorecard } from "./scorecard"

const PROVIDER = process.env.EVAL_JUDGE_PROVIDER ?? DEFAULT_PROVIDER_ID
const KEY = process.env.EVAL_JUDGE_KEY ?? ""
const MODEL = process.env.EVAL_JUDGE_MODEL
const ROOT = path.resolve(__dirname, "../../../..")
const OUT = path.join(ROOT, "coverage", "eval")

describe.skipIf(!KEY)("RAG faithfulness (keyed)", () => {
  it(
    "scores faithfulness and answer relevancy per fixture",
    async () => {
      // Created here (not at describe-scope) so a keyless, skipped run never
      // creates or leaks anything on disk — see injection.judged.eval.ts for
      // why describe-scope mkdtempSync leaks even when the suite is skipped.
      const dir = mkdtempSync(path.join(tmpdir(), "eval-rag-judged-"))
      try {
        await runRagFaithfulness(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 }
  )
})

async function runRagFaithfulness(dir: string): Promise<void> {
  const judgedFixtures = loadFixtures<RagFixture>(path.join(ROOT, "evals/rag")).filter(
    (fx) => fx.t2
  )
  expect(judgedFixtures.length, "no RAG fixtures with t2 config").toBeGreaterThan(0)

  const passthrough = { encrypt: (s: string) => s, decrypt: (s: string) => s }
  const credentials = new AiCredentialStore({
    filePath: path.join(dir, "credentials.json"),
    protector: passthrough,
  })
  await credentials.set(PROVIDER, KEY)

  const descriptor = defaultProviderCatalog().find((p) => p.id === PROVIDER)
  const model = MODEL ?? descriptor?.defaultModel
  if (!model) throw new Error(`No model for provider ${PROVIDER}`)
  const provider = descriptor!.create(KEY)

  const results: ScoreResult[] = []

  for (const fixture of judgedFixtures) {
    const memDir = mkdtempSync(path.join(tmpdir(), "eval-rag-judge-mem-"))
    try {
      const service = new MemoryService(new MemoryStore(path.join(memDir, "memory.json")), {
        embed: async () => null,
      })
      for (const s of fixture.seed) {
        await service.save({ text: s.text, scope: s.scope })
      }
      const hits = await service.search(fixture.query, 10, {
        workspaceId: fixture.askedInWorkspace,
        includeGlobal: true,
      })
      const context = hits.map((h) => h.entry.text).join("\n")
      const answer = await generateAnswerFromContext(provider, model, fixture.query, context)

      const faithfulness = await judge(provider, model, {
        rubric: "Is the answer supported by the context?",
        context,
        answer,
      })
      const relevancy = await judge(provider, model, {
        rubric: "Does the answer address the query?",
        context: fixture.query,
        answer,
      })

      results.push({
        id: fixture.id,
        tier: "T2" as const,
        tags: ["rag-judged", "faithfulness", "relevancy"],
        passed: faithfulness.verdict === "pass" && relevancy.verdict === "pass",
        gated: false,
        metrics: {
          faithfulness: faithfulness.score,
          relevancy: relevancy.score,
        },
      })
    } finally {
      rmSync(memDir, { recursive: true, force: true })
    }
  }

  const card = buildScorecard("rag-judged", results)
  writeScorecard(OUT, card)
}

async function generateAnswerFromContext(
  provider: ChatProvider,
  model: string,
  query: string,
  context: string
): Promise<string> {
  let text = ""
  const userText = [
    "Use only the provided context to answer the query.",
    'If context is insufficient, say: "I cannot find enough information in the provided context."',
    `Query:\n${query}`,
    `Context:\n${context}`,
    "Answer:",
  ].join("\n\n")

  for await (const ev of provider.stream({
    model,
    system: "You are a retrieval-grounded assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [],
    maxTokens: 512,
  })) {
    if (ev.type === "text") text += ev.text
  }

  return text.trim()
}
