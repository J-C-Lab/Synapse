# @synapsepkg/plugin-sdk

TypeScript types and runtime contract for [Synapse](../../README.md) plugins.

A Synapse plugin is a CommonJS module that registers commands and returns
declarative view descriptions. The host renders those descriptions with a
unified shadcn-based UI — plugin code never touches the DOM, never embeds
an iframe, and never imports React.

```ts
import type { PluginModule } from "@synapsepkg/plugin-sdk"

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

## Command handlers

The host invokes `run(invocation, ctx)` — **invocation is the first argument,
`ctx` is the second**. `ctx` is the gated `PluginContext` (storage, clipboard,
notifications, system). The same order applies to `onSearchChange(text, ctx)`,
`onAction(actionId, payload, ctx)`, and `dispose(ctx)`.

## Status

P0 scope is type-first: the package defines the plugin contract, command
handlers, declarative views, actions, and host-provided runtime APIs. Runtime
APIs (storage, clipboard, notifications, system, runtime) are provided by the
host through a bridge that conforms to the same interfaces.

Clipboard APIs support text, image, and file-list payloads through
`ClipboardContent`. The text-only helpers (`readText` / `writeText`) remain for
simple commands, while clipboard-history plugins should use `read` / `write` /
`watch` so P0 can cover all required clipboard entry types.

## Network

`ctx.network` is gated by the `network:https` capability and constrained to the
declared host/method/path scope (https only, no private IPs, no cross-origin
redirects, no cookie jar).

- `fetch(url, init)` — buffers the whole response (bounded by the host's
  buffered cap). Use for APIs/JSON.
- `fetchStream(url, init)` — streams the response body as backpressured chunks,
  for large downloads that would exceed the buffered cap. Same scope, consent,
  DNS-pinning, redirect, and abort guarantees; bounded by the larger stream cap.

```ts
const res = await ctx.network.fetchStream("https://api.example.com/big.ndjson")
for await (const chunk of res.body) {
  // chunk is a Uint8Array; process incrementally (consume the body once)
}
```

## Background triggers

Plugins may declare background triggers in `synapse.json`. Triggers are the
**only** way to register event-driven background handlers — there is no runtime
`register` API on `ctx`.

```jsonc
{
  "triggers": [
    {
      "id": "sync-5min",
      "type": "timer",
      "schedule": { "intervalMs": 300000 },
      "handler": "triggers.onSyncTick",
      "uses": [
        {
          "capability": "network:https",
          "scope": { "hosts": ["api.example.com"], "methods": ["GET"], "paths": ["/**"] },
          "budget": { "maxCalls": 10, "period": "1h" },
        },
      ],
      "limits": { "minIntervalMs": 60000, "maxConcurrency": 1 },
    },
  ],
}
```

Export handlers on a `triggers` object in your plugin module. The handler name
must match the manifest (`triggers.onSyncTick` → export `onSyncTick`):

```ts
export const triggers = {
  async onSyncTick(event, ctx) {
    // event is a safe, metadata-only payload; call gated capabilities for sensitive data
  },
}
```

### Cron trigger

Use `type: "cron"` with a **5-field crontab** string (`minute hour day month weekday`).
Schedules use local time and must fire no more often than once per minute. The safe
event matches the timer payload (`scheduledAt`, `firedAt`, `driftMs`):

```jsonc
{
  "triggers": [
    {
      "id": "daily-summary",
      "type": "cron",
      "schedule": "0 9 * * *",
      "handler": "triggers.onDailySummary",
      "uses": [{ "capability": "notification", "budget": { "maxCalls": 1, "period": "1d" } }],
      "limits": { "maxConcurrency": 1 },
    },
  ],
}
```

Use `type: "timer"` with `{ "intervalMs": N }` for fixed-interval schedules instead.

### Clipboard trigger

Clipboard changes use `type: "clipboard"`. The safe event carries metadata only
(`contentTypes`, `textLength`, `changedAt`) — no raw text or content hash.
Read full clipboard text via `ctx.clipboard.readText()` / `read()` inside the
handler (requires `clipboard:read` in the trigger's `uses`):

```jsonc
{
  "triggers": [
    {
      "id": "on-clip",
      "type": "clipboard",
      "scope": { "contentTypes": ["text"] },
      "handler": "triggers.onClip",
      "uses": [{ "capability": "clipboard:read", "budget": { "maxCalls": 20, "period": "1h" } }],
      "limits": { "minIntervalMs": 500, "maxConcurrency": 1 },
    },
  ],
}
```

Legacy `activationEvents: ["clipboard:change"]` with `events.onClipboardChange`
still works but delivers the full `ClipboardContent` payload; new plugins should
prefer manifest triggers.

### Filesystem (`fs.watch`) trigger

Directory changes use `type: "fs.watch"`. The safe event carries
`rootId`, `relativePath`, `kind`, and optional `size` / `ext` — never an
absolute path. Resolve or read through `ctx.fs.resolvePath()` / `ctx.fs.readText()`
(declare matching scopes in the trigger's `uses`):

```jsonc
{
  "triggers": [
    {
      "id": "watch-dls",
      "type": "fs.watch",
      "scope": { "paths": ["~/Downloads/**"], "events": ["create", "modify"] },
      "handler": "triggers.onDownloads",
      "uses": [
        {
          "capability": "fs:read",
          "scope": { "paths": ["~/Downloads/**"] },
          "budget": { "maxCalls": 20, "period": "1h" },
        },
      ],
      "limits": { "minIntervalMs": 1000, "maxConcurrency": 1 },
    },
  ],
}
```

Paths must live under `~/`, must not target sensitive directories (for example
`~/.ssh`), and support `/**` or `/*.ext` globs.

### Global hotkey (`hotkey`) trigger

Register a system-wide keyboard shortcut with `type: "hotkey"`. The safe event
carries `accelerator` and `pressedAt` only. The host reserves the launcher
shortcut and rejects conflicts with other plugins or OS-registered shortcuts:

```jsonc
{
  "triggers": [
    {
      "id": "quick-capture",
      "type": "hotkey",
      "scope": { "accelerator": "CommandOrControl+Shift+K" },
      "handler": "triggers.onQuickCapture",
      "uses": [
        {
          "capability": "notification",
          "budget": { "maxCalls": 10, "period": "1h" },
        },
      ],
      "limits": { "minIntervalMs": 500, "maxConcurrency": 1 },
    },
  ],
}
```

Use Electron accelerator syntax (`CmdOrCtrl`, `Shift`, `Alt`, `F1`–`F12`, etc.).
