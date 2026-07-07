import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

export interface FixtureMeta {
  id: string
  title: string
  tier: "T0" | "T1" | "T2"
  tags: string[]
  source?: string
}

export interface ScoreResult {
  id: string
  tier: string
  tags: string[]
  /** Whether this fixture met its expectation. */
  passed: boolean
  /** When true, a failure fails the `pnpm eval` gate; when false it is recorded only. */
  gated: boolean
  metrics?: Record<string, number>
  /** Failure reason — never contains secrets or raw payloads verbatim. */
  detail?: string
}

export function loadFixtures<T extends FixtureMeta>(dir: string): T[] {
  if (!existsSync(dir)) return []
  const out: T[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue
    const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T
    if (!raw || typeof raw.id !== "string" || !raw.id) {
      throw new Error(`Fixture ${name} is missing an id`)
    }
    out.push(raw)
  }
  return out
}
