// @vitest-environment node
// Builds the scaffolded project with esbuild (via @deskit/plugin-cli), which
// fails under jsdom's TextEncoder — so this suite runs in the node env.
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { buildPlugin } from "@deskit/plugin-cli"
import { parseManifest } from "@deskit/plugin-manifest"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defaultCommandId, ScaffoldError, scaffoldPlugin } from "./scaffold"

// vitest runs from the repo root, so the template payload is at a stable path.
const TEMPLATE_DIR = path.resolve(process.cwd(), "packages/create-deskit-plugin/template")

let workDir: string

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "create-deskit-"))
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

describe("scaffoldPlugin", () => {
  it("scaffolds a project whose manifest the host accepts", async () => {
    const targetDir = path.join(workDir, "my-plugin")
    await scaffoldPlugin({
      targetDir,
      templateDir: TEMPLATE_DIR,
      pluginId: "com.alice.timer",
      packageName: "timer",
      displayName: "Timer",
      description: "A timer plugin",
      author: "Alice",
      commandId: defaultCommandId("com.alice.timer"),
      clipboard: false,
    })

    expect(await exists(path.join(targetDir, "deskit.json"))).toBe(true)
    expect(await exists(path.join(targetDir, "package.json"))).toBe(true)
    expect(await exists(path.join(targetDir, "src", "index.ts"))).toBe(true)
    // _gitignore / _github must land as their dotfile names
    expect(await exists(path.join(targetDir, ".gitignore"))).toBe(true)
    expect(await exists(path.join(targetDir, "_gitignore"))).toBe(false)
    expect(await exists(path.join(targetDir, ".github", "workflows", "release.yml"))).toBe(true)
    expect(await exists(path.join(targetDir, "_github"))).toBe(false)

    const manifest = parseManifest(
      JSON.parse(await fs.readFile(path.join(targetDir, "deskit.json"), "utf-8"))
    )
    expect(manifest.id).toBe("com.alice.timer")
    expect(manifest.author).toBe("Alice")
    expect(manifest.contributes.commands[0]?.id).toBe("timer.run")

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf-8"))
    expect(pkg.name).toBe("timer")
    // Hard constraint: the template must use published versions, never workspace:*
    const deps = JSON.stringify(pkg.devDependencies)
    expect(deps).not.toContain("workspace:")
    expect(deps).toContain("@deskit/plugin-cli")

    // The patched entry references the new command id.
    const entry = await fs.readFile(path.join(targetDir, "src", "index.ts"), "utf-8")
    expect(entry).toContain('"timer.run"')
    expect(entry).not.toContain('"hello.world"')
  })

  it("adds clipboard activation + permission when requested", async () => {
    const targetDir = path.join(workDir, "clip")
    await scaffoldPlugin({
      targetDir,
      templateDir: TEMPLATE_DIR,
      pluginId: "com.alice.clip",
      packageName: "clip",
      displayName: "Clip",
      description: "Clipboard plugin",
      author: "Alice",
      commandId: "clip.run",
      clipboard: true,
    })
    const manifest = parseManifest(
      JSON.parse(await fs.readFile(path.join(targetDir, "deskit.json"), "utf-8"))
    )
    expect(manifest.contributes.activationEvents).toEqual(["clipboard:change"])
    expect(manifest.permissions).toContain("clipboard:read")
  })

  it("produces a buildable project (create → build closed loop)", async () => {
    const targetDir = path.join(workDir, "buildable")
    await scaffoldPlugin({
      targetDir,
      templateDir: TEMPLATE_DIR,
      pluginId: "com.alice.buildable",
      packageName: "buildable",
      displayName: "Buildable",
      description: "x",
      author: "Alice",
      commandId: defaultCommandId("com.alice.buildable"),
      clipboard: false,
    })

    const result = await buildPlugin({ projectDir: targetDir })
    expect(path.basename(result.packagePath)).toBe("com.alice.buildable-0.1.0.deskit")
    expect(await exists(result.packagePath)).toBe(true)
  })

  it("rejects an invalid plugin id", async () => {
    await expect(
      scaffoldPlugin({
        targetDir: path.join(workDir, "bad"),
        templateDir: TEMPLATE_DIR,
        pluginId: "NotValid",
        packageName: "bad",
        displayName: "Bad",
        description: "x",
        author: "",
        commandId: "bad.run",
        clipboard: false,
      })
    ).rejects.toBeInstanceOf(ScaffoldError)
  })

  it("refuses a non-empty target without force", async () => {
    const targetDir = path.join(workDir, "occupied")
    await fs.mkdir(targetDir, { recursive: true })
    await fs.writeFile(path.join(targetDir, "keep.txt"), "x")
    await expect(
      scaffoldPlugin({
        targetDir,
        templateDir: TEMPLATE_DIR,
        pluginId: "com.alice.occupied",
        packageName: "occupied",
        displayName: "Occupied",
        description: "x",
        author: "",
        commandId: "occupied.run",
        clipboard: false,
      })
    ).rejects.toBeInstanceOf(ScaffoldError)
  })
})

function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  )
}
