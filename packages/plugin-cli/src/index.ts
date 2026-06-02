// @deskit/plugin-cli
//
// Programmatic API behind the `deskit-plugin` command. Bundles a plugin
// project into an installable `.deskit` package and manages dev-mode links
// into a running DesKit install.

export { buildPlugin, PluginBuildError } from "./build"
export type { BuildOptions, BuildResult } from "./build"

export { type PluginWatcher, type WatchOptions, watchPlugin } from "./dev"

export { type DevLinkOptions, linkDevPlugin, listDevPlugins, unlinkDevPlugin } from "./dev-links"

export { type LoadedManifest, MANIFEST_FILENAME, readManifest } from "./manifest-io"

export { DEV_PLUGINS_FILENAME, devPluginsFilePath, resolveDeskitDataDir } from "./userdata"

export { createDeskitPackage, type PackageFile } from "./zip"
