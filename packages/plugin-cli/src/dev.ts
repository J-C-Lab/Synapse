import type { BuildContext } from "esbuild"
import * as path from "node:path"
import process from "node:process"
import { context as esbuildContext } from "esbuild"
import { PluginBuildError } from "./build"
import { readManifest } from "./manifest-io"

export interface WatchOptions {
  projectDir?: string
  entry?: string
  minify?: boolean
  /** Invoked after every successful rebuild (and once on the initial build). */
  onRebuild?: (errors: string[]) => void
}

export interface PluginWatcher {
  /** Absolute path of the bundled entry being kept fresh (manifest.main). */
  outFile: string
  dispose: () => Promise<void>
}

/**
 * Keep `manifest.main` continuously rebuilt from source while editing. The
 * host loads `dev`-source plugins directly from their project directory, so
 * watch only needs to refresh the bundle in place — no repackaging.
 */
export async function watchPlugin(options: WatchOptions = {}): Promise<PluginWatcher> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd())
  const { manifest } = await readManifest(projectDir)

  const entryAbs = path.resolve(projectDir, options.entry ?? "src/index.ts")
  const outFile = path.resolve(projectDir, manifest.main)

  const ctx: BuildContext = await esbuildContext({
    entryPoints: [entryAbs],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    minify: options.minify ?? false,
    logLevel: "silent",
    plugins: options.onRebuild
      ? [
          {
            name: "deskit-dev-notify",
            setup(build) {
              build.onEnd((result) => {
                options.onRebuild?.(result.errors.map((e) => e.text))
              })
            },
          },
        ]
      : [],
  })

  try {
    await ctx.watch()
  } catch (err) {
    await ctx.dispose()
    throw new PluginBuildError("Failed to start watch mode.", [
      err instanceof Error ? err.message : String(err),
    ])
  }

  return { outFile, dispose: () => ctx.dispose() }
}
