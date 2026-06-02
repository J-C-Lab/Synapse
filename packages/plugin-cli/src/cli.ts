#!/usr/bin/env node
import * as path from "node:path"
import process from "node:process"
import { ManifestValidationError } from "@deskit/plugin-manifest"
import { buildPlugin, PluginBuildError } from "./build"
import { watchPlugin } from "./dev"
import { linkDevPlugin, unlinkDevPlugin } from "./dev-links"
import { readManifest } from "./manifest-io"

interface ParsedArgs {
  command: string | undefined
  positional: string[]
  flags: Map<string, string | boolean>
}

const USAGE = `deskit-plugin — build and develop DesKit plugins

Usage:
  deskit-plugin build    [dir] [--entry src/index.ts] [--out <dir>] [--minify]
  deskit-plugin validate [dir]
  deskit-plugin dev      [dir] [--entry src/index.ts] [--data-dir <dir>] [--no-link]
  deskit-plugin link     [dir] [--data-dir <dir>]
  deskit-plugin unlink   [dir] [--data-dir <dir>]

Commands:
  build      Bundle the plugin and write an installable <id>-<version>.deskit
  validate   Structurally validate deskit.json
  dev        Watch + rebuild and register the project for DesKit dev loading
  link       Register the project in DesKit's dev-plugins.json
  unlink     Remove the project from DesKit's dev-plugins.json
`

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)

  if (!args.command || args.flags.has("help") || args.flags.has("h")) {
    process.stdout.write(USAGE)
    return
  }

  const projectDir = path.resolve(str(args.flags.get("cwd")) ?? args.positional[0] ?? process.cwd())
  const dataDir = str(args.flags.get("data-dir"))

  switch (args.command) {
    case "build":
      await runBuild(projectDir, args)
      return
    case "validate":
      await runValidate(projectDir)
      return
    case "dev":
      await runDev(projectDir, dataDir, args)
      return
    case "link": {
      const linked = await linkDevPlugin(projectDir, { dataDir })
      info(`Linked dev plugin: ${linked}`)
      info(`Reload plugins in DesKit to pick it up.`)
      return
    }
    case "unlink": {
      const unlinked = await unlinkDevPlugin(projectDir, { dataDir })
      info(`Unlinked dev plugin: ${unlinked}`)
      return
    }
    default:
      fail(`Unknown command: ${args.command}\n\n${USAGE}`)
  }
}

async function runBuild(projectDir: string, args: ParsedArgs): Promise<void> {
  const result = await buildPlugin({
    projectDir,
    entry: str(args.flags.get("entry")),
    outDir: str(args.flags.get("out")),
    minify: Boolean(args.flags.get("minify")),
  })
  info(`Built ${result.manifest.id}@${result.manifest.version}`)
  info(`  bundle:  ${path.relative(process.cwd(), result.outFile)}`)
  info(`  package: ${path.relative(process.cwd(), result.packagePath)}`)
  info(`  files:   ${result.files.map((f) => f.archivePath).join(", ")}`)
}

async function runValidate(projectDir: string): Promise<void> {
  const { manifest } = await readManifest(projectDir)
  info(`deskit.json is valid: ${manifest.id}@${manifest.version}`)
  info(`  commands: ${manifest.contributes.commands.map((c) => c.id).join(", ")}`)
}

async function runDev(
  projectDir: string,
  dataDir: string | undefined,
  args: ParsedArgs
): Promise<void> {
  const { manifest } = await readManifest(projectDir)

  if (!args.flags.get("no-link")) {
    const linked = await linkDevPlugin(projectDir, { dataDir })
    info(`Linked dev plugin: ${linked}`)
  }

  const outRel = path.relative(process.cwd(), path.resolve(projectDir, manifest.main))
  const watcher = await watchPlugin({
    projectDir,
    entry: str(args.flags.get("entry")),
    onRebuild(errors) {
      if (errors.length > 0) {
        process.stderr.write(`[deskit-plugin] rebuild failed:\n  ${errors.join("\n  ")}\n`)
      } else {
        info(`rebuilt ${manifest.id} → ${outRel}`)
      }
    },
  })
  info(`Watching ${manifest.id}. Reload plugins in DesKit after edits. Ctrl+C to stop.`)

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void watcher.dispose().finally(resolve)
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
  })
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string
    if (token.startsWith("--")) {
      const body = token.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1))
      } else if (body.startsWith("no-")) {
        flags.set(body, true)
      } else {
        const next = rest[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(body, next)
          i++
        } else {
          flags.set(body, true)
        }
      }
    } else {
      positional.push(token)
    }
  }

  return { command, positional, flags }
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function info(message: string): void {
  process.stdout.write(`${message}\n`)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ManifestValidationError || err instanceof PluginBuildError) {
    process.stderr.write(`${err.name}: ${err.message}\n`)
    for (const issue of err.issues) process.stderr.write(`  - ${issue}\n`)
    process.exit(1)
  }
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
