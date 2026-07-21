import type { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import { promises as fs, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CREATION_CRASH_EXIT_CODE } from "./child-task-creation-crash-child"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-child-task-creation-crash-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const TSX_CLI = createRequire(path.join(__dirname, "resolve-tsx.cjs")).resolve("tsx/cli")
const TSCONFIG = path.join(__dirname, "..", "..", "..", "..", "..", "tsconfig.node.json")
const CHILD_SCRIPT = path.join(__dirname, "child-task-creation-crash-child.ts")

function run(phase: "reserve" | "checkpoint" | "recover"): { exitCode: number; stderr: string } {
  const configPath = path.join(dir, `config-${phase}.json`)
  writeFileSync(configPath, JSON.stringify({ baseDir: dir, phase }), "utf-8")
  try {
    execFileSync(process.execPath, [TSX_CLI, "--tsconfig", TSCONFIG, CHILD_SCRIPT, configPath], {
      stdio: "pipe",
    })
    return { exitCode: 0, stderr: "" }
  } catch (err) {
    const status = (err as { status?: number | null }).status
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
    if (status === null || status === undefined) throw new Error(`child failed to spawn: ${stderr}`)
    return { exitCode: status, stderr }
  }
}

describe("durable child-task creation crash recovery", () => {
  it.each(["reserve", "checkpoint"] as const)(
    "reconciles a crash after the %s creation write in a fresh process",
    (phase) => {
      const crash = run(phase)
      expect(crash.exitCode, crash.stderr).toBe(CREATION_CRASH_EXIT_CODE)

      const recovered = run("recover")
      expect(recovered.exitCode, recovered.stderr).toBe(0)
      const result = JSON.parse(readFileSync(path.join(dir, "recovery-result.json"), "utf-8")) as {
        childAccountPresent: boolean
        childCheckpointPresent: boolean
        childTaskCount: number
        nonTerminalRunIds: string[]
        dispatched: string[]
      }
      expect(result).toEqual({
        childAccountPresent: false,
        childCheckpointPresent: false,
        childTaskCount: 0,
        nonTerminalRunIds: ["origin-1"],
        dispatched: [],
      })
    },
    30_000
  )
})
