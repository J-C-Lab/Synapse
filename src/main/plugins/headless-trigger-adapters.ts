import type { HotkeyTriggerScope } from "@synapse/plugin-manifest"
import type { HotkeyAdapter } from "./hotkey-adapter"

/** No-op hotkey adapter for tools-only / headless contexts (MCP stdio, unit
 *  tests) so {@link PluginHost} never statically imports electron's
 *  `globalShortcut`. */
export function createHeadlessHotkeyAdapter(): HotkeyAdapter {
  return {
    register: (
      _pluginId: string,
      _triggerId: string,
      _scope: HotkeyTriggerScope,
      _fire: (event: import("./hotkey-adapter").HotkeyEvent) => void
    ) => null,
  }
}
