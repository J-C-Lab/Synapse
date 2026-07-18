import { describe, expect, it } from "vitest"
import {
  findCaseFoldCollisions,
  findExactDuplicatePaths,
  isSafeSkillRelativePath,
  normalizeSkillRelativePath,
  skillPathDepth,
  UnsafeSkillPathError,
} from "./skill-paths"

describe("normalizeSkillRelativePath", () => {
  it("passes through a simple relative path unchanged", () => {
    expect(normalizeSkillRelativePath("SKILL.md")).toBe("SKILL.md")
    expect(normalizeSkillRelativePath("assets/logo.png")).toBe("assets/logo.png")
  })

  it("converts backslashes to forward slashes", () => {
    expect(normalizeSkillRelativePath("assets\\logo.png")).toBe("assets/logo.png")
  })

  it("collapses redundant separators and './' segments", () => {
    expect(normalizeSkillRelativePath("./assets//logo.png")).toBe("assets/logo.png")
  })

  it.each(["/etc/passwd", "~/secrets"])("rejects an absolute path: %s", (rawPath) => {
    expect(() => normalizeSkillRelativePath(rawPath)).toThrow(UnsafeSkillPathError)
  })

  it.each(["C:\\Windows\\System32", "//server/share/file", "\\\\server\\share\\file"])(
    "rejects a drive-qualified or UNC path: %s",
    (rawPath) => {
      expect(() => normalizeSkillRelativePath(rawPath)).toThrow(UnsafeSkillPathError)
    }
  )

  it.each(["../secrets.txt", "assets/../../escape", "..\\..\\escape"])(
    "rejects path traversal: %s",
    (rawPath) => {
      expect(() => normalizeSkillRelativePath(rawPath)).toThrow(UnsafeSkillPathError)
    }
  )

  it("rejects an embedded NUL byte", () => {
    expect(() => normalizeSkillRelativePath("assets/logo.png\0.exe")).toThrow(UnsafeSkillPathError)
  })

  it("rejects a colon in a path segment (ADS syntax)", () => {
    expect(() => normalizeSkillRelativePath("SKILL.md:hidden-stream")).toThrow(UnsafeSkillPathError)
  })

  it.each(["notes ", "notes.", "dir./file.txt"])(
    "rejects a segment ending with a space or dot: %s",
    (rawPath) => {
      expect(() => normalizeSkillRelativePath(rawPath)).toThrow(UnsafeSkillPathError)
    }
  )

  it.each(["CON", "con.txt", "NUL", "com1", "COM1.log", "lpt9"])(
    "rejects a reserved Windows device name: %s",
    (rawPath) => {
      expect(() => normalizeSkillRelativePath(rawPath)).toThrow(UnsafeSkillPathError)
    }
  )

  it("rejects an empty path", () => {
    expect(() => normalizeSkillRelativePath("")).toThrow(UnsafeSkillPathError)
  })

  it("rejects a path with no real segments", () => {
    expect(() => normalizeSkillRelativePath("./.")).toThrow(UnsafeSkillPathError)
  })

  it("allows a legitimate nested asset path", () => {
    expect(normalizeSkillRelativePath("assets/icons/logo.svg")).toBe("assets/icons/logo.svg")
  })
})

describe("isSafeSkillRelativePath", () => {
  it("returns true for a safe path and false for an unsafe one", () => {
    expect(isSafeSkillRelativePath("SKILL.md")).toBe(true)
    expect(isSafeSkillRelativePath("../escape")).toBe(false)
  })
})

describe("skillPathDepth", () => {
  it("counts segments", () => {
    expect(skillPathDepth("SKILL.md")).toBe(1)
    expect(skillPathDepth("assets/icons/logo.svg")).toBe(3)
  })
})

describe("findCaseFoldCollisions", () => {
  it("finds no collisions among distinct-cased-but-different paths", () => {
    expect(findCaseFoldCollisions(["SKILL.md", "assets/logo.png"])).toEqual([])
  })

  it("finds a collision between two entries that differ only by case", () => {
    const collisions = findCaseFoldCollisions(["SKILL.md", "skill.md", "assets/a.png"])
    expect(collisions).toHaveLength(1)
    expect(collisions[0]).toEqual(expect.arrayContaining(["SKILL.md", "skill.md"]))
  })
})

describe("findExactDuplicatePaths", () => {
  it("returns an empty array when every path is unique", () => {
    expect(findExactDuplicatePaths(["SKILL.md", "assets/a.png"])).toEqual([])
  })

  it("finds an exact duplicate path", () => {
    expect(findExactDuplicatePaths(["SKILL.md", "assets/a.png", "SKILL.md"])).toEqual(["SKILL.md"])
  })
})
