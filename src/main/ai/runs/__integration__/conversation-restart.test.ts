import type { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import { promises as fs, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-conversation-restart-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const TSX_CLI = createRequire(path.join(__dirname, "resolve-tsx.cjs")).resolve("tsx/cli")
const TSCONFIG = path.join(__dirname, "..", "..", "..", "..", "..", "tsconfig.node.json")
const CHILD_SCRIPT = path.join(__dirname, "conversation-restart-child.ts")

interface RunOutcome {
  exitCode: number
  stderr: string
}

function runChild(
  scenario: "tombstone" | "content-conflict" | "stale-fencing",
  phase: "seed" | "assert"
): RunOutcome {
  try {
    execFileSync(
      process.execPath,
      [TSX_CLI, "--tsconfig", TSCONFIG, CHILD_SCRIPT, dir, scenario, phase],
      { stdio: "pipe" }
    )
    return { exitCode: 0, stderr: "" }
  } catch (err) {
    const status = (err as { status?: number | null }).status
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
    if (status === null || status === undefined) {
      throw new Error(`conversation child failed to start: ${stderr}`)
    }
    return { exitCode: status, stderr }
  }
}

describe("conversation durability after a real process restart", () => {
  it.each(["tombstone", "content-conflict", "stale-fencing"] as const)(
    "%s remains enforced by a fresh process",
    (scenario) => {
      const seed = runChild(scenario, "seed")
      expect(seed.exitCode, seed.stderr).toBe(91)
      const assertion = runChild(scenario, "assert")
      expect(assertion.exitCode, assertion.stderr).toBe(0)
      expect(JSON.parse(readFileSync(path.join(dir, `${scenario}.result.json`), "utf-8"))).toEqual({
        ok: true,
      })
    },
    30_000
  )
})
