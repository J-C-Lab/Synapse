// @synapsepkg/plugin-cli
//
// Programmatic API behind the `synapse-plugin` command. Bundles a plugin
// project into an installable `.syn` package and manages dev-mode links
// into a running Synapse install.

export { buildPlugin, PluginBuildError } from "./build"
export type { BuildOptions, BuildResult } from "./build"

export { type PluginWatcher, type WatchOptions, watchPlugin } from "./dev"

export { type DevLinkOptions, linkDevPlugin, listDevPlugins, unlinkDevPlugin } from "./dev-links"

export { type LoadedManifest, MANIFEST_FILENAME, readManifest } from "./manifest-io"

export { DEV_PLUGINS_FILENAME, devPluginsFilePath, resolveSynapseDataDir } from "./userdata"

export { createSynapsePackage, type PackageFile } from "./zip"
