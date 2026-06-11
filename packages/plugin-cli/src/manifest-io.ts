import type { PluginManifest } from "@synapsepkg/plugin-manifest"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { ManifestValidationError, parseManifest } from "@synapsepkg/plugin-manifest"

export const MANIFEST_FILENAME = "synapse.json"

export interface LoadedManifest {
  manifest: PluginManifest
  manifestPath: string
  /** Raw on-disk bytes, preserved so packaging ships the author's exact file. */
  raw: string
}

/**
 * Read and structurally validate `<projectDir>/synapse.json`. Engine
 * compatibility is intentionally not checked here — that is the host's
 * concern at install time, not the build tool's.
 */
export async function readManifest(projectDir: string): Promise<LoadedManifest> {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, "utf-8")
  } catch (err) {
    if (isFileNotFound(err)) {
      throw new ManifestValidationError(`No ${MANIFEST_FILENAME} found in ${projectDir}`, [
        `Expected a manifest at ${manifestPath}`,
      ])
    }
    throw err
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    throw new ManifestValidationError(`${MANIFEST_FILENAME} is not valid JSON`, [
      err instanceof Error ? err.message : String(err),
    ])
  }

  return { manifest: parseManifest(parsedJson), manifestPath, raw }
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
