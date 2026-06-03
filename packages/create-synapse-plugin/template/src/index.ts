import type { ListView, PluginModule } from "@synapse/plugin-sdk"

// A Synapse plugin is a CommonJS module that registers commands returning
// declarative views. The host renders them with its own UI — plugin code
// never touches the DOM and never imports React. See @synapse/plugin-sdk.
const plugin: PluginModule = {
  commands: {
    "hello.world": {
      run(_input, _ctx): ListView {
        return {
          type: "list",
          items: [
            {
              id: "greeting",
              title: "Hello from your Synapse plugin!",
              subtitle: {
                en: "Edit src/index.ts, then run `npm run dev`",
                "zh-CN": "编辑 src/index.ts，然后运行 `npm run dev`",
              },
              actions: [{ type: "copy", value: "Hello from Synapse" }],
            },
          ],
        }
      },
    },
  },
}

export = plugin
