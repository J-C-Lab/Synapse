# @synapse/plugin-sdk

TypeScript types and runtime contract for [Synapse](../../README.md) plugins.

A Synapse plugin is a CommonJS module that registers commands and returns
declarative view descriptions. The host renders those descriptions with a
unified shadcn-based UI — plugin code never touches the DOM, never embeds
an iframe, and never imports React.

```ts
import type { PluginModule } from "@synapse/plugin-sdk"

const plugin: PluginModule = {
  commands: {
    "hello.world": {
      async run(_input, _ctx) {
        return {
          type: "list",
          items: [
            {
              id: "hello",
              title: "Hello",
              actions: [{ type: "copy", value: "world" }],
            },
          ],
        }
      },
    },
  },
}

export = plugin
```

## Status

P0 scope is type-first: the package defines the plugin contract, command
handlers, declarative views, actions, and host-provided runtime APIs. Runtime
APIs (storage, clipboard, notifications, system, runtime) are provided by the
host through a bridge that conforms to the same interfaces.

Clipboard APIs support text, image, and file-list payloads through
`ClipboardContent`. The text-only helpers (`readText` / `writeText`) remain for
simple commands, while clipboard-history plugins should use `read` / `write` /
`watch` so P0 can cover all required clipboard entry types.
