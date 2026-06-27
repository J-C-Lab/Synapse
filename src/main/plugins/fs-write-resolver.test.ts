import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  fsWriteMkdir,
  fsWriteMove,
  fsWriteText,
  resolveVerifiedWritePath,
} from "./fs-write-resolver"

describe("fs-write-resolver", () => {
  let home: string

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-fsw-"))
    await fs.mkdir(path.join(home, "Downloads"), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it("resolves a not-yet-existing path inside the declared root", async () => {
    const abs = await resolveVerifiedWritePath(home, "~/Downloads/**", "images/cat.png")
    expect(abs).toBe(`${home.replace(/\\/g, "/")}/Downloads/images/cat.png`)
  })

  it("rejects a path whose real parent escapes the root via symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-out-"))
    await fs.symlink(
      outside,
      path.join(home, "Downloads", "link"),
      process.platform === "win32" ? "junction" : "dir"
    )

    await expect(resolveVerifiedWritePath(home, "~/Downloads/**", "link/evil.txt")).rejects.toThrow(
      /escape|symlink/i
    )

    await fs.rm(outside, { recursive: true, force: true })
  })

  it("writeText creates a new file but refuses to overwrite an existing one", async () => {
    await fsWriteText(home, "~/Downloads/**", "a.txt", "hello")
    expect(await fs.readFile(path.join(home, "Downloads", "a.txt"), "utf8")).toBe("hello")
    await expect(fsWriteText(home, "~/Downloads/**", "a.txt", "again")).rejects.toThrow(/exists/i)
  })

  it("mkdir is idempotent and reports whether it created the directory", async () => {
    expect(await fsWriteMkdir(home, "~/Downloads/**", "images")).toBe(true)
    expect(await fsWriteMkdir(home, "~/Downloads/**", "images")).toBe(false)
  })

  it("move fails if the target already exists (no silent overwrite)", async () => {
    await fsWriteText(home, "~/Downloads/**", "src.txt", "x")
    await fsWriteText(home, "~/Downloads/**", "dst.txt", "y")
    await expect(
      fsWriteMove(home, "~/Downloads/**", "src.txt", "~/Downloads/**", "dst.txt")
    ).rejects.toThrow(/exists/i)
  })

  it("move relocates a file when the target is free", async () => {
    await fsWriteText(home, "~/Downloads/**", "src.txt", "x")
    await fsWriteMove(home, "~/Downloads/**", "src.txt", "~/Downloads/**", "images/src.txt")
    expect(await fs.readFile(path.join(home, "Downloads", "images", "src.txt"), "utf8")).toBe("x")
    await expect(fs.access(path.join(home, "Downloads", "src.txt"))).rejects.toThrow()
  })
})
