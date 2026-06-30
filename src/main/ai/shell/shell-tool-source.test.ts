import type { ShellExecutor, ShellRunResult } from "./shell-executor"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { SHELL_FQ_PREFIX, ShellToolSource } from "./shell-tool-source"

const RUN_SHELL = `shell:core/run_shell`
const WORK = path.resolve("/work")
const okResult: ShellRunResult = {
  stdout: "hi",
  stderr: "",
  exitCode: 0,
  truncated: false,
  timedOut: false,
  durationMs: 5,
}

function makeSource(overrides: Partial<ConstructorParameters<typeof ShellToolSource>[0]> = {}) {
  const run = vi.fn().mockResolvedValue(okResult)
  const executor: ShellExecutor = { run }
  const audit = vi.fn()
  const source = new ShellToolSource({
    executor,
    allowedRoots: () => [WORK],
    defaultCwd: () => WORK,
    audit,
    ...overrides,
  })
  return { source, run, audit }
}

describe("shellToolSource", () => {
  it("owns the shell namespace and lists run_shell with confirmation annotations", () => {
    const { source } = makeSource()
    expect(source.ownsTool(`${SHELL_FQ_PREFIX}run_shell`)).toBe(true)
    expect(source.ownsTool("com.x/y")).toBe(false)
    const [tool] = source.listTools()
    expect(tool.manifestTool.name).toBe("run_shell")
    expect(tool.manifestTool.annotations).toMatchObject({ requiresConfirmation: true })
  })

  it("refuses to execute when disabled, even on a direct invoke", async () => {
    const { source, run } = makeSource({ enabled: () => false })
    const result = await source.invokeTool(RUN_SHELL, { command: "echo hi" })
    expect(result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("runs a command in the default cwd and returns structured output", async () => {
    const { source, run, audit } = makeSource()
    const result = await source.invokeTool(RUN_SHELL, { command: "echo hi" })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: "echo hi", cwd: WORK }))
    expect(result.structured).toMatchObject({ exitCode: 0 })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ command: "echo hi", cwd: WORK }))
  })

  it("rejects an out-of-root cwd without calling the executor", async () => {
    const { source, run } = makeSource()
    const result = await source.invokeTool(RUN_SHELL, { command: "ls", cwd: "/etc" })
    expect(result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("errors on empty command", async () => {
    const { source, run } = makeSource()
    const result = await source.invokeTool(RUN_SHELL, { command: "  " })
    expect(result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("marks the result as error when exitCode is non-zero", async () => {
    const { source, run } = makeSource()
    run.mockResolvedValueOnce({ ...okResult, exitCode: 2 })
    const result = await source.invokeTool(RUN_SHELL, { command: "false" })
    expect(result.isError).toBe(true)
  })

  it("hides tools when disabled via enabled()", () => {
    const { source } = makeSource({ enabled: () => false })
    expect(source.listTools()).toEqual([])
    expect(source.ownsTool(`${SHELL_FQ_PREFIX}run_shell`)).toBe(false)
  })
})
