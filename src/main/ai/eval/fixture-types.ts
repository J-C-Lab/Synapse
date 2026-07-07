import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface FixtureMeta {
  id: string
  title: string
  tier: "T0" | "T1" | "T2"
  tags: string[]
  source?: string
}

export interface ScoreResult {
  id: string
  tier: FixtureMeta["tier"]
  tags: string[]
  /** Whether this fixture met its expectation. */
  passed: boolean
  /** When true, a failure fails the `pnpm eval` gate; when false it is recorded only. */
  gated: boolean
  /**
   * Scorer-defined numeric measurements (e.g. `exposed`, `recall`). There is no
   * shared schema across corpora — each scorer documents and owns its own keys.
   * Not every scorer needs to set this.
   */
  metrics?: Record<string, number>
  /** Failure reason — never contains secrets or raw payloads verbatim. */
  detail?: string
}

export function loadFixtures<T extends FixtureMeta>(dir: string): T[] {
  if (!existsSync(dir)) return []
  const out: T[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue
    const filePath = join(dir, name)
    let raw: T
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8")) as T
    } catch (err) {
      throw new Error(
        `Fixture ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!raw || typeof raw.id !== "string" || !raw.id) {
      throw new Error(`Fixture ${filePath} is missing an id`)
    }
    out.push(raw)
  }
  return out
}
