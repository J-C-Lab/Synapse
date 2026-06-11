import type { ListView, PluginModule } from "@synapsepkg/plugin-sdk"

// A Synapse plugin is a CommonJS module that registers commands returning
// declarative views, and/or headless tools that AI agents can call. The host
// renders views with its own UI — plugin code never touches the DOM and never
// imports React. See @synapsepkg/plugin-sdk.
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
  // Tools are headless: structured input → structured result, no UI. The host
  // validates `input` against the `inputSchema` declared in synapse.json before
  // calling, so it is safe to trust its shape here.
  tools: {
    greet(input: { name: string }) {
      const greeting = `Hello, ${input.name}!`
      return {
        content: [{ type: "text", text: greeting }],
        structured: { greeting },
      }
    },
  },
}

export = plugin
