import type { ClipboardContent } from "./clipboard"
import type { PluginContext } from "./context"
import type { ToolHandler } from "./tools"
import type { View } from "./views"

/**
 * What the host passes when a command starts. `initialQuery` is the trailing
 * token from the launcher search box at the moment of activation — useful
 * for "search-as-you-type" style commands.
 */
export interface CommandInvocation {
  commandId: string
  initialQuery?: string
}

/**
 * The four lifecycle hooks a plugin command can implement. Only `run` is
 * required. Hooks may be sync or async; the host always awaits.
 */
export interface CommandHandler {
  /** Called once when the command becomes active. Return the initial view. */
  run: (input: CommandInvocation, ctx: PluginContext) => Promise<View> | View

  /**
   * Called when the user types into the in-view search box. Debounced by
   * the host (currently 150ms). Return a fresh view to replace the previous.
   */
  onSearchChange?: (text: string, ctx: PluginContext) => Promise<View> | View

  /**
   * Called when the user triggers a `custom` Action. `actionId` matches
   * `CustomAction.id`. Return a new view to navigate, or `void` to leave the
   * current view in place.
   */
  onAction?: (
    actionId: string,
    payload: unknown,
    ctx: PluginContext
  ) => Promise<View | void> | View | void

  /** Called when the user leaves the command (Esc, switching, plugin disabled). */
  dispose?: (ctx: PluginContext) => void
}

export interface ClipboardChangeEvent {
  content: ClipboardContent
}

export interface PluginEventHandlers {
  /**
   * Called by the host when the OS clipboard changes. This hook is only
   * invoked for plugins that declare `clipboard:change` in
   * `contributes.activationEvents`.
   */
  onClipboardChange?: (event: ClipboardChangeEvent, ctx: PluginContext) => Promise<void> | void
}

/**
 * The shape a plugin entry module must export.
 *
 * @example
 * ```ts
 * import type { PluginModule } from "@synapsepkg/plugin-sdk"
 *
 * const plugin: PluginModule = {
 *   commands: {
 *     "my.cmd": {
 *       run() { return { type: "list", items: [] } }
 *     }
 *   }
 * }
 *
 * export = plugin
 * ```
 *
 * Plugins built with TypeScript should compile to CommonJS — the host
 * loads via `module.exports`, not ESM. Use `export = plugin` (TS) or
 * `module.exports = plugin` (JS).
 */
export interface PluginModule {
  commands: Record<string, CommandHandler>
  events?: PluginEventHandlers
  /**
   * Headless tools the plugin exposes to AI agents (and external MCP clients).
   * Each key must match a `contributes.tools[].name` in the manifest. Tools
   * are independent of `commands` — a plugin may ship either or both.
   */
  tools?: Record<string, ToolHandler>
}
