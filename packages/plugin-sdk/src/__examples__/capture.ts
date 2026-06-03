/* eslint-disable no-restricted-syntax */
// Fixture: validates DetailView + system.captureScreen + open-path action.
// Mirror of stage 5's capture plugin (P0 = full-screen only).
import type { DetailView, PluginModule } from "../index"

const plugin: PluginModule = {
  commands: {
    "capture.fullscreen": {
      async run(_input, ctx) {
        const { path } = await ctx.system.captureScreen()
        await ctx.clipboard.writeText(path)
        await ctx.notifications.show({
          title: "Synapse",
          body: `Saved to ${path}`,
        })
        return view(path)
      },
    },
  },
}

function view(path: string): DetailView {
  return {
    type: "detail",
    markdown: `**Screenshot saved**\n\n\`${path}\``,
    metadata: [{ label: { en: "Path", "zh-CN": "路径" }, value: path }],
    actions: [
      {
        type: "copy",
        label: { en: "Copy path", "zh-CN": "复制路径" },
        value: path,
      },
      {
        type: "open-path",
        label: { en: "Open file", "zh-CN": "打开文件" },
        path,
      },
      {
        type: "run-command",
        label: { en: "Capture again", "zh-CN": "再截一张" },
        commandId: "capture.fullscreen",
      },
    ],
  }
}

export = plugin
