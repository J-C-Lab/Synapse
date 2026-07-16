import type { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import { promises as fs, readFileSync } from "node:fs"
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

const TSX_BIN = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.CMD" : "tsx"
)
const TSCONFIG = path.join(__dirname, "..", "..", "..", "..", "..", "tsconfig.node.json")
const CHILD_SCRIPT = path.join(__dirname, "conversation-restart-child.ts")

function quoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`
}

function runChild(
  scenario: "tombstone" | "content-conflict" | "stale-fencing",
  phase: "seed" | "assert"
): number {
  try {
    execFileSync(
      quoteArg(TSX_BIN),
      ["--tsconfig", TSCONFIG, CHILD_SCRIPT, dir, scenario, phase].map(quoteArg),
      { stdio: "pipe", shell: true }
    )
    return 0
  } catch (err) {
    const status = (err as { status?: number | null }).status
    if (status === null || status === undefined) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
      throw new Error(`conversation child failed to start: ${stderr}`)
    }
    return status
  }
}

describe("conversation durability after a real process restart", () => {
  it.each(["tombstone", "content-conflict", "stale-fencing"] as const)(
    "%s remains enforced by a fresh process",
    (scenario) => {
      expect(runChild(scenario, "seed")).toBe(91)
      expect(runChild(scenario, "assert")).toBe(0)
      expect(JSON.parse(readFileSync(path.join(dir, `${scenario}.result.json`), "utf-8"))).toEqual({
        ok: true,
      })
    },
    30_000
  )
})
