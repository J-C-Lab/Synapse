import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  isEngineCompatible,
  ManifestValidationError,
  parseManifest,
  validateCredentialDeclarations,
} from "@synapse/plugin-manifest"
import { applyBuiltinManifestPatches } from "./builtin-manifest-patches"
import { PLUGIN_HOST_VERSION } from "./types"

// The manifest schema and engine-compatibility logic live in the shared
// @synapse/plugin-manifest package (also consumed by the plugin CLI). This
// module keeps the host-specific concerns: reading `synapse.json` off disk and
// composing structural validation with the host's engine-version check.
export { isEngineCompatible, ManifestValidationError } from "@synapse/plugin-manifest"

export interface ParseManifestOptions {
  hostVersion?: string
}

export async function loadPluginManifest(
  pluginDir: string,
  options: ParseManifestOptions = {}
): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, "synapse.json")
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
  const manifest = parseManifest(applyBuiltinManifestPatches(raw))

  const hostVersion = options.hostVersion ?? PLUGIN_HOST_VERSION
  if (!isEngineCompatible(manifest.engines.synapse, hostVersion)) {
    throw new ManifestValidationError("Plugin manifest targets an incompatible Synapse version", [
      `engines.synapse=${manifest.engines.synapse}, host=${hostVersion}`,
    ])
  }

  try {
    validateCredentialDeclarations(manifest)
  } catch (err) {
    throw new ManifestValidationError(
      err instanceof Error ? err.message : "Invalid credential declarations",
      [err instanceof Error ? err.message : String(err)]
    )
  }

  return manifest
}
