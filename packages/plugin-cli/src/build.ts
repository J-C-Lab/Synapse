import type { PluginManifest } from "@deskit/plugin-manifest"
import type { PackageFile } from "./zip"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { build as esbuild } from "esbuild"
import { readManifest } from "./manifest-io"
import { createDeskitPackage } from "./zip"

export class PluginBuildError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = "PluginBuildError"
    this.issues = issues
  }
}

export interface BuildOptions {
  /** Plugin project root (contains deskit.json). Defaults to cwd. */
  projectDir?: string
  /** Source entry to bundle. Defaults to "src/index.ts". */
  entry?: string
  /** Directory the `.deskit` package is written to. Defaults to projectDir. */
  outDir?: string
  /** Minify the bundle. Defaults to false. */
  minify?: boolean
}

export interface BuildResult {
  manifest: PluginManifest
  /** Absolute path of the bundled CJS entry (manifest.main). */
  outFile: string
  /** Absolute path of the produced `.deskit` package. */
  packagePath: string
  /** Files included in the package. */
  files: PackageFile[]
}

/**
 * Bundle a plugin project into an installable `.deskit` package:
 *   1. read + structurally validate `deskit.json`
 *   2. esbuild-bundle the source entry into a self-contained CJS file at
 *      `manifest.main` (the DesKit sandbox has no `require`, so the output
 *      must inline its dependencies)
 *   3. zip `deskit.json` + bundle + declared assets into `<id>-<version>.deskit`
 */
export async function buildPlugin(options: BuildOptions = {}): Promise<BuildResult> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd())
  const { manifest, manifestPath } = await readManifest(projectDir)

  const entryRel = options.entry ?? "src/index.ts"
  const entryAbs = path.resolve(projectDir, entryRel)
  if (!(await isFile(entryAbs))) {
    throw new PluginBuildError("Plugin entry source was not found.", [
      `Expected an entry at ${entryAbs} (override with --entry)`,
    ])
  }

  const outFile = path.resolve(projectDir, manifest.main)
  await bundle(entryAbs, outFile, options.minify ?? false)

  const files = await collectPackageFiles(manifest, projectDir, manifestPath, outFile)

  const outDir = path.resolve(options.outDir ?? projectDir)
  await fs.mkdir(outDir, { recursive: true })
  const packagePath = path.join(
    outDir,
    `${safePluginFileName(manifest.id)}-${manifest.version}.deskit`
  )
  await createDeskitPackage(files, packagePath)

  return { manifest, outFile, packagePath, files }
}

async function bundle(entryAbs: string, outFile: string, minify: boolean): Promise<void> {
  const result = await esbuild({
    entryPoints: [entryAbs],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    minify,
    logLevel: "silent",
    // The sandbox injects the `deskit` runtime as a global and the @deskit/*
    // packages are type-only, so nothing should be marked external; everything
    // a plugin actually pulls in at runtime must be inlined.
  })
  if (result.errors.length > 0) {
    throw new PluginBuildError(
      "Plugin bundle failed.",
      result.errors.map((e) => e.text)
    )
  }
}

async function collectPackageFiles(
  manifest: PluginManifest,
  projectDir: string,
  manifestPath: string,
  outFile: string
): Promise<PackageFile[]> {
  const files = new Map<string, PackageFile>()

  files.set("deskit.json", { absPath: manifestPath, archivePath: "deskit.json" })
  files.set(toArchiveKey(manifest.main), {
    absPath: outFile,
    archivePath: manifest.main,
  })

  const assetPaths = new Set<string>()
  if (manifest.icon) assetPaths.add(manifest.icon)
  for (const command of manifest.contributes.commands) {
    if (command.icon) assetPaths.add(command.icon)
  }

  const missing: string[] = []
  for (const asset of assetPaths) {
    const absPath = path.resolve(projectDir, asset)
    if (!(await isFile(absPath))) {
      missing.push(asset)
      continue
    }
    files.set(toArchiveKey(asset), { absPath, archivePath: asset })
  }

  if (missing.length > 0) {
    throw new PluginBuildError(
      "Declared assets are missing.",
      missing.map((asset) => `Asset not found: ${asset}`)
    )
  }

  return [...files.values()]
}

function toArchiveKey(relPath: string): string {
  return relPath.split(path.sep).join("/")
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile()
  } catch {
    return false
  }
}

function safePluginFileName(pluginId: string): string {
  return pluginId.replace(/[^\w.-]/g, "_")
}
