import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { isEngineCompatible, ManifestValidationError, parseManifest } from "@deskit/plugin-manifest"
import { PLUGIN_HOST_VERSION } from "./types"

// The manifest schema and engine-compatibility logic live in the shared
// @deskit/plugin-manifest package (also consumed by the plugin CLI). This
// module keeps the host-specific concerns: reading `deskit.json` off disk and
// composing structural validation with the host's engine-version check.
export { isEngineCompatible, ManifestValidationError } from "@deskit/plugin-manifest"

export interface ParseManifestOptions {
  hostVersion?: string
}

export async function loadPluginManifest(
  pluginDir: string,
  options: ParseManifestOptions = {}
): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, "deskit.json")
  const raw = await fs.readFile(manifestPath, "utf-8")
  try {
    return parsePluginManifest(JSON.parse(raw), options)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ManifestValidationError("Plugin manifest is not valid JSON", [err.message])
    }
    throw err
  }
}

export function parsePluginManifest(
  raw: unknown,
  options: ParseManifestOptions = {}
): PluginManifest {
  const manifest = parseManifest(raw)

  const hostVersion = options.hostVersion ?? PLUGIN_HOST_VERSION
  if (!isEngineCompatible(manifest.engines.deskit, hostVersion)) {
    throw new ManifestValidationError("Plugin manifest targets an incompatible DesKit version", [
      `engines.deskit=${manifest.engines.deskit}, host=${hostVersion}`,
    ])
  }

  return manifest
}
