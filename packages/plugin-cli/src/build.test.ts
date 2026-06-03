// @vitest-environment node
// esbuild's UTF-8 invariant check fails under jsdom's TextEncoder, so this
// suite (which actually runs esbuild) must use the node environment.
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as yauzl from "yauzl"
import { buildPlugin, PluginBuildError } from "./build"

let projectDir: string

const MANIFEST = {
  id: "com.synapse.fixture",
  name: "fixture",
  displayName: { en: "Fixture", "zh-CN": "夹具" },
  description: "Build-loop fixture plugin",
  version: "1.2.3",
  author: "Synapse",
  engines: { synapse: "^0.2.0" },
  main: "dist/index.js",
  contributes: {
    commands: [{ id: "fixture.run", title: "Run", mode: "view" }],
  },
  permissions: [],
}

const ENTRY_SOURCE = `
import { greeting } from "./greeting"
const plugin = {
  commands: {
    "fixture.run": {
      run() {
        return { type: "list", items: [{ id: "x", title: greeting(), actions: [] }] }
      },
    },
  },
}
export = plugin
`

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cli-"))
  await fs.mkdir(path.join(projectDir, "src"), { recursive: true })
  await fs.writeFile(path.join(projectDir, "synapse.json"), JSON.stringify(MANIFEST, null, 2))
  await fs.writeFile(path.join(projectDir, "src", "index.ts"), ENTRY_SOURCE)
  // A relative import proves esbuild bundles the project into a single file —
  // the sandbox has no `require`, so multi-file plugins must be inlined.
  await fs.writeFile(
    path.join(projectDir, "src", "greeting.ts"),
    `export function greeting() { return "hello from fixture" }\n`
  )
})

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true })
})

describe("buildPlugin", () => {
  it("produces a .syn package with the host-expected layout", async () => {
    const result = await buildPlugin({ projectDir })

    expect(path.basename(result.packagePath)).toBe("com.synapse.fixture-1.2.3.syn")
    expect(await fileExists(result.packagePath)).toBe(true)
    expect(await fileExists(result.outFile)).toBe(true)

    const entries = await listZipEntries(result.packagePath)
    expect(entries).toContain("synapse.json")
    expect(entries).toContain("dist/index.js")
  })

  it("bundles into a self-contained CJS module the sandbox can run", async () => {
    const result = await buildPlugin({ projectDir })
    const code = await fs.readFile(result.outFile, "utf-8")

    // Mirror plugin-sandbox.ts: wrap the bundle and run it with an injected
    // module/exports — no `require` is available.
    const moduleObject = { exports: {} as Record<string, unknown> }
    // eslint-disable-next-line react/naming-convention-context-name -- this is node:vm, not React.createContext
    const sandboxContext = vm.createContext({
      module: moduleObject,
      exports: moduleObject.exports,
    })
    new vm.Script(`(function (module, exports) {\n${code}\n})(module, exports)`).runInContext(
      sandboxContext
    )

    const exported = moduleObject.exports as {
      commands: Record<string, { run: () => { type: string; items: { title: string }[] } }>
    }
    const view = exported.commands["fixture.run"]!.run()
    expect(view.type).toBe("list")
    expect(view.items[0]?.title).toBe("hello from fixture")
  })

  it("rejects an invalid manifest before bundling", async () => {
    await fs.writeFile(path.join(projectDir, "synapse.json"), JSON.stringify({ id: "x" }))
    await expect(buildPlugin({ projectDir })).rejects.toThrow()
  })

  it("reports a missing entry source", async () => {
    await fs.rm(path.join(projectDir, "src", "index.ts"))
    await expect(buildPlugin({ projectDir })).rejects.toBeInstanceOf(PluginBuildError)
  })
})

function fileExists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  )
}

function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = []
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("failed to open zip"))
        return
      }
      zip.on("entry", (entry: yauzl.Entry) => {
        names.push(entry.fileName)
        zip.readEntry()
      })
      zip.on("end", () => resolve(names))
      zip.on("error", reject)
      zip.readEntry()
    })
  })
}
