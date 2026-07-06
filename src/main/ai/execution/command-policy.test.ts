import { describe, expect, it } from "vitest"
import { classifyCommand } from "./command-policy"

describe("classifyCommand", () => {
  it("allows common read-only commands", () => {
    expect(classifyCommand("git status").decision).toBe("allow")
    expect(classifyCommand("rg FIXME src").decision).toBe("allow")
  })

  it("asks for install and test commands", () => {
    expect(classifyCommand("pnpm test").decision).toBe("ask")
    expect(classifyCommand("pnpm install").decision).toBe("ask")
  })

  it("asks for workspace-relative recursive deletion instead of hard-denying it", () => {
    expect(classifyCommand("rm -rf ./dist").decision).toBe("ask")
    expect(classifyCommand("rm -rf node_modules").decision).toBe("ask")
    expect(classifyCommand("rd /s dist").decision).toBe("ask")
    expect(classifyCommand("Remove-Item -Recurse -Force ./dist").decision).toBe("ask")
    expect(classifyCommand("Remove-Item -Recurse ./dist").decision).toBe("ask")
  })

  it("denies destructive system or home-directory commands", () => {
    expect(classifyCommand("rm -rf /").decision).toBe("deny")
    expect(classifyCommand("rm -rf ~/Documents").decision).toBe("deny")
    expect(classifyCommand("rm -rf C:\\Users\\Administrator").decision).toBe("deny")
    expect(classifyCommand("Remove-Item -Recurse -Force C:\\Users\\Administrator").decision).toBe(
      "deny"
    )
    expect(classifyCommand("rd /s C:\\Users\\Administrator").decision).toBe("deny")
    expect(classifyCommand("Format-Volume -DriveLetter C").decision).toBe("deny")
    expect(classifyCommand("Stop-Computer").decision).toBe("deny")
    expect(classifyCommand("shutdown /s").decision).toBe("deny")
  })

  it("denies environment enumeration commands", () => {
    expect(classifyCommand("printenv").decision).toBe("deny")
    expect(classifyCommand("env").decision).toBe("deny")
    expect(classifyCommand("Get-ChildItem Env:").decision).toBe("deny")
  })

  it("takes the strictest decision across chained command segments", () => {
    expect(classifyCommand("git status && rm -rf ~/Documents").decision).not.toBe("allow")
    expect(classifyCommand("echo ok && rm -rf /").decision).toBe("deny")
    expect(
      classifyCommand("echo ok; Remove-Item -Recurse -Force C:\\Users\\Administrator").decision
    ).toBe("deny")
    expect(classifyCommand("ls; rm -rf ~/Documents").decision).not.toBe("allow")
  })
})
