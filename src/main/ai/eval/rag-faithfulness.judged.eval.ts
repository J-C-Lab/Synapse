import type { ChatProvider } from "../providers/types"
// @vitest-environment node
import type { Baseline } from "./baselines"
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
import { checkAgainstBaseline, loadRequiredBaseline } from "./baselines"
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
    "scores correctness per fixture and gates on the rag-judged baseline",
    async () => {
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

interface RagResult {
  id: string
  correctness: 0 | 1
}

/** Judge-input text for the correctness rubric: what the fixture expects,
 *  next to what the model actually answered. Extracted as a pure function
 *  so it has keyless test coverage — see rag-faithfulness.judged.eval.test.ts. */
export function buildCorrectnessContext(expectedAnswerContains: string, answer: string): string {
  return `Expected: ${expectedAnswerContains}\n\nActual answer: ${answer}`
}

/** Builds the rag-judged scorecard from per-fixture correctness results and
 *  a baseline check — passed is computed FROM the baseline check, not set
 *  independently from the raw judge verdict, so the scorecard's `passed`
 *  field and the caller's `expect(check.ok)` can never disagree about the
 *  same run. Extracted as a pure function for keyless test coverage. */
export function ragScorecardFromResults(
  results: RagResult[],
  check: { ok: boolean; regressions: string[] }
) {
  return buildScorecard(
    "rag-judged",
    results.map((r) => ({
      id: r.id,
      tier: "T2" as const,
      tags: ["rag-judged", "correctness"],
      passed: !check.regressions.includes(r.id),
      gated: true,
      metrics: { correctness: r.correctness },
    }))
  )
}

async function runRagFaithfulness(dir: string): Promise<void> {
  const judgedFixtures = loadFixtures<RagFixture>(path.join(ROOT, "evals/rag")).filter(
    (fx): fx is RagFixture & { t2: NonNullable<RagFixture["t2"]> } => Boolean(fx.t2)
  )
  expect(judgedFixtures.length, "no RAG fixtures with t2 config").toBeGreaterThan(0)

  const passthrough = { encrypt: (s: string) => s, decrypt: (s: string) => s }
  const credentials = new AiCredentialStore({
    filePath: path.join(dir, "credentials.json"),
    protector: passthrough,
  })
  await credentials.set(PROVIDER, KEY)

  const descriptor = defaultProviderCatalog().find((p) => p.id === PROVIDER)
  const model = MODEL?.trim() || descriptor?.defaultModel
  if (!model) throw new Error(`No model for provider ${PROVIDER}`)
  const provider = descriptor!.create(KEY)

  const results: RagResult[] = []

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

      const correctness = await judge(provider, model, {
        rubric:
          "Does the answer match what's expected? A correct refusal counts as " +
          "matching if the expectation describes insufficient context.",
        context: buildCorrectnessContext(fixture.t2.expectedAnswerContains, answer),
        answer,
      })

      results.push({ id: fixture.id, correctness: correctness.verdict === "pass" ? 1 : 0 })
    } finally {
      rmSync(memDir, { recursive: true, force: true })
    }
  }

  // writeScorecard() MUST run before the baseline expect() below, on every
  // path — a regression's expect() throws, and if that happened first the
  // scorecard JSON would never be written, leaving the nightly reporter
  // unable to tell "regressed" from "suite produced no output" for this
  // suite. See spec §2's "ordering" fix.
  const baseline: Baseline = loadRequiredBaseline(
    path.join(ROOT, "evals/baselines/rag-judged.json")
  )
  const metrics = Object.fromEntries(results.map((r) => [r.id, r.correctness]))
  const check = checkAgainstBaseline(metrics, baseline)
  const card = ragScorecardFromResults(results, check)
  writeScorecard(OUT, card)

  expect(check.ok, `RAG judged regression on: ${check.regressions.join(", ")}`).toBe(true)
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
