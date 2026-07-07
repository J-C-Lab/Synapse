import type { ScoreResult } from "./fixture-types"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface Scorecard {
  generatedAt: number
  suite: string
  results: ScoreResult[]
  aggregates: Record<string, number>
}

export function buildScorecard(
  suite: string,
  results: ScoreResult[],
  now: () => number = Date.now
): Scorecard {
  const gatedFailures = results.filter((r) => r.gated && !r.passed).length
  return {
    generatedAt: now(),
    suite,
    results,
    aggregates: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      gatedFailures,
    },
  }
}

export function toJUnit(card: Scorecard): string {
  const failures = card.aggregates.gatedFailures
  const cases = card.results
    .map((r) => {
      const body =
        r.gated && !r.passed
          ? `<failure message="${escapeXml(r.detail ?? "failed")}"/>`
          : r.passed
            ? ""
            : `<skipped message="recorded finding"/>`
      return `    <testcase name="${escapeXml(r.id)}" classname="${escapeXml(card.suite)}">${body}</testcase>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeXml(card.suite)}" tests="${card.results.length}" failures="${failures}">
${cases}
</testsuite>`
}

export function writeScorecard(dir: string, card: Scorecard): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${card.suite}.json`), `${JSON.stringify(card, null, 2)}\n`)
  writeFileSync(join(dir, `${card.suite}.junit.xml`), `${toJUnit(card)}\n`)
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
