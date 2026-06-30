import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { isWithinAllowedRoot, resolveCwd } from "./allowed-root"

const work = path.resolve("/work")

describe("isWithinAllowedRoot", () => {
  it("accepts a path inside a root and the root itself", () => {
    expect(isWithinAllowedRoot(path.join(work, "proj"), [work])).toBe(true)
    expect(isWithinAllowedRoot(work, [work])).toBe(true)
  })

  it("rejects escape via .. and sibling-prefix collisions", () => {
    expect(isWithinAllowedRoot(path.resolve(work, "..", "etc"), [work])).toBe(false)
    expect(isWithinAllowedRoot(path.resolve("/workshop"), [work])).toBe(false)
  })

  it("rejects when there are no roots", () => {
    expect(isWithinAllowedRoot(work, [])).toBe(false)
  })
})

describe("resolveCwd", () => {
  it("uses defaultCwd when candidate is undefined", () => {
    expect(resolveCwd(undefined, work, [work])).toEqual({ ok: true, cwd: work })
  })

  it("resolves a relative candidate against defaultCwd and validates it", () => {
    expect(resolveCwd("proj", work, [work])).toEqual({ ok: true, cwd: path.join(work, "proj") })
  })

  it("fails a candidate outside the roots", () => {
    expect(resolveCwd(path.resolve("/etc"), work, [work]).ok).toBe(false)
  })
})
