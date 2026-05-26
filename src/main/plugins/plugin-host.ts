import type { PluginBridgeAdapters, PluginRuntimeSnapshot } from "./plugin-bridge"
import * as path from "node:path"
import { createElectronPluginAdapters } from "./electron-adapters"
import { PluginBridge } from "./plugin-bridge"
import { discoverPlugins } from "./plugin-discovery"
import { PluginRegistry } from "./plugin-registry"
import { PluginSandbox } from "./plugin-sandbox"

export interface PluginHostOptions {
  userDataDir: string
  resourcesDir: string
  adapters?: PluginBridgeAdapters
  runtime?: () => PluginRuntimeSnapshot
}

export class PluginHost {
  readonly bridge: PluginBridge
  readonly sandbox: PluginSandbox
  readonly registry: PluginRegistry

  constructor(private readonly options: PluginHostOptions) {
    this.bridge = new PluginBridge({
      userDataDir: options.userDataDir,
      adapters: options.adapters ?? createElectronPluginAdapters(options.userDataDir),
      runtime: options.runtime,
    })
    this.sandbox = new PluginSandbox({ bridge: this.bridge })
    this.registry = new PluginRegistry({ sandbox: this.sandbox })
  }

  async init(): Promise<void> {
    const discovered = await discoverPlugins({
      builtinDir: path.join(this.options.resourcesDir, "builtin-plugins"),
      userDir: path.join(this.options.userDataDir, "plugins"),
      devFilePath: path.join(this.options.userDataDir, "dev-plugins.json"),
    })
    await this.registry.load(discovered)
  }
}
