import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configureRootLogger, logger } from "./index"

const dirs: string[] = []
function tempUserData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "synapse-rootlog-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("root logger", () => {
  it("writes to stderr (never throws before configuration)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    logger.warn("hello-stderr", { a: 1 })
    const line = spy.mock.calls.map((c) => String(c[0])).join("")
    expect(line).toContain("hello-stderr")
    expect(line).toContain('"a":1')
  })

  it("also writes to <userData>/logs/main.log after configureRootLogger", () => {
    const userData = tempUserData()
    configureRootLogger({ userDataDir: userData, level: "info" })
    logger.info("to-file", { port: 5173 })
    const contents = readFileSync(path.join(userData, "logs", "main.log"), "utf-8")
    expect(contents).toContain("to-file")
    expect(contents).toContain('"port":5173')
  })

  it("child loggers carry a nested scope into the file", () => {
    const userData = tempUserData()
    configureRootLogger({ userDataDir: userData })
    logger.child("svc").error("boom")
    const contents = readFileSync(path.join(userData, "logs", "main.log"), "utf-8")
    const last = JSON.parse(contents.trim().split("\n").at(-1) as string)
    expect(last).toMatchObject({ scope: "svc", level: "error", msg: "boom" })
  })
})
