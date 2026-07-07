import type { ScoreResult } from "./fixture-types"
import type { InjectionFixture } from "./scorers/injection"
import type { RagFixture } from "./scorers/rag"
import type { TrajectoryFixture } from "./scorers/trajectory"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { checkAgainstBaseline, loadBaseline } from "./baselines"
import { loadFixtures } from "./fixture-types"
import { buildScorecard, writeScorecard } from "./scorecard"
import { scoreInjectionT0 } from "./scorers/injection"
import { scoreRag } from "./scorers/rag"
import { scoreTrajectory } from "./scorers/trajectory"

const ROOT = path.resolve(__dirname, "../../../..") // repo root from src/main/ai/eval
const OUT = path.join(ROOT, "coverage", "eval")

describe("eval ratchet (T0)", () => {
  it("scores every corpus and gates on gated failures", async () => {
    const results: ScoreResult[] = []

    for (const fx of loadFixtures<TrajectoryFixture>(path.join(ROOT, "evals/trajectories"))) {
      results.push(await scoreTrajectory(fx))
    }
    for (const fx of loadFixtures<InjectionFixture>(path.join(ROOT, "evals/injection"))) {
      results.push(scoreInjectionT0(fx))
    }

    const baseline = loadBaseline(path.join(ROOT, "evals/baselines/rag.json"))
    for (const fx of loadFixtures<RagFixture>(path.join(ROOT, "evals/rag"))) {
      const result = await scoreRag(fx)
      const bl = checkAgainstBaseline(result.metrics ?? {}, baseline)
      results.push(
        bl.ok
          ? result
          : { ...result, passed: false, detail: `baseline: ${bl.regressions.join(",")}` }
      )
    }

    const card = buildScorecard("t0", results)
    writeScorecard(OUT, card)

    const gatedFailures = results.filter((r) => r.gated && !r.passed)
    expect(gatedFailures, gatedFailures.map((r) => `${r.id}: ${r.detail}`).join("\n")).toHaveLength(
      0
    )
  })
})
