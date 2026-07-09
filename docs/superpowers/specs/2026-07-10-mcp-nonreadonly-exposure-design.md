# Per-Plugin Non-Read-Only MCP Exposure

> Date: 2026-07-10 · Status: draft, pending review
> Follow-up to a real end-to-end test finding: with the default `readOnlyOnly`
> exposure policy, `com.synapse.downloads-organizer`'s only tool
> (`classifyAndMove`) never appears in any external MCP client's tool list —
> it has no `readOnlyHint` (correctly, since it moves files) and there is no
> way, today, for a user to opt a plugin into broader exposure
> (`McpToolExposurePolicy`'s `"all"` value exists in code but has never been
> wired to any config surface). Decided by user Q&A on 2026-07-10 (see the
> `synapse-platform-positioning` memory), the same interactive-decision
> process used for the three items parked by the mcp-resources-phase1 spec.

## Why this is safe to build now

Before the `2026-07-09-headless-elevated-approval-design.md` slice landed,
opening this up would have been dangerous: the headless process's
`CapabilityGate` fell back to `createCapabilityGovernance()`'s default
`approve: async () => true`, so any `elevated`-tier capability reachable
through a newly-exposed tool would have been silently rubber-stamped. That
gap is now closed — an external caller invoking an elevated capability
either needs an explicit per-capability preauthorization or triggers a live
GUI approval that fails closed on any transport error. This spec only
changes *what appears in `tools/list`*; call-time enforcement is unchanged
and already correct.

## Guiding principle

**Exposure is its own trust decision, not a visibility filter with the real
gate living elsewhere.** This was explicitly corrected during design: it is
tempting to say "expose everything, `CapabilityGate` will catch anything
dangerous" — but `CapabilityGate` only ever runs when a tool invocation
touches a *managed capability*. A non-read-only tool that happens to declare
zero capabilities (none exist in the two built-in plugins today, but nothing
stops a future one) would be reachable with no gate at all once exposed.
The per-plugin toggle this spec adds is therefore itself a meaningful
consent decision — off by default, explicit opt-in, warned accordingly —
not a convenience switch.

## Goal (this slice)

A per-plugin toggle, default off: when off (today's behavior, unchanged),
only tools with `annotations.readOnlyHint: true` appear in the external
MCP `tools/list`. When on for a given plugin, **all** of that plugin's
tools appear — including `destructiveHint`/`requiresConfirmation` ones —
because splitting hairs between "elevated" and "destructive" at the
exposure layer would just be a second, redundant safety model bolted onto
the one `CapabilityGate` already owns (decided explicitly during design:
exposure and authorization are two layers, don't fold one into the other).

## Non-goals (explicitly deferred)

- **Per-tool granularity.** Considered and rejected — plugin-level is the
  chosen granularity (a middle ground between an all-or-nothing global
  toggle and a per-tool list that would need its own management UI for
  little practical benefit with today's two built-in plugins).
- **Changing `McpToolExposurePolicy`'s existing `"all"` global escape
  hatch.** It stays exactly as-is (present in code, no config surface,
  effectively a manual/test-only override) — this spec adds a second,
  narrower mechanism alongside it, not a replacement.
- **Any change to `CapabilityGate`, `GrantStore`, or the headless-approval
  mechanism.** Those are already correct and unchanged by this spec — see
  "Why this is safe to build now."

## 1. Data model — a new store, not an extension of an existing one

New file `src/main/plugins/mcp-exposure-store.ts`, structurally mirroring
`grant-store.ts`:

```ts
export interface McpExposureRecord {
  identity: GrantIdentity
  nonReadOnlyExposed: boolean
  updatedAt: number
}
```

Keyed by the full `GrantIdentity` (`pluginId` + `publisherId` +
`signingKeyFingerprint` + `capabilityDeclarationHash`), **not** a bare
`pluginId` — explicitly decided during design: a plugin update that rotates
`capabilityDeclarationHash` (e.g. because it added a new, more dangerous
tool) must not silently inherit a prior exposure decision, the same
no-silent-trust-inheritance invariant `GrantStore` and
`externalMcpPreauthorized` already both follow.

`McpExposureStore` gets two methods, same shape as the
`externalMcpPreauthorized` pair added in the prior slice:

```ts
async isNonReadOnlyExposed(identity: GrantIdentity): Promise<boolean>
async setNonReadOnlyExposed(identity: GrantIdentity, value: boolean): Promise<void>
```

Unlike `setExternalMcpPreauthorized`, this does **not** require a
pre-existing grant — exposure and grant are orthogonal (a tool can be
listed without being callable, and today's `readOnlyHint` tools already
work exactly that way: listed regardless of grant state, gated at call
time). Persisted to its own file
(`path.join(userDataDir, "plugins", "mcp-exposure.json")`).

## 2. `shouldExpose()` — async, with a corrected exposure rule

`SynapseMcpToolService.shouldExpose` and the two things that call it
(`listTools()`, `callTool()`) all become `async` — the new store lookup is
async, and per design discussion, making the whole path honestly async is
preferable to loading the store into a synchronous in-memory snapshot at
startup (MCP request handlers already support returning a `Promise`; two
of this service's four handlers — `listResources`/`readResource` — already
are async).

```ts
export interface SynapseMcpToolServiceOptions {
  // ...existing fields unchanged...
  /** Backs the per-plugin non-read-only exposure toggle. Omit to disable
   *  entirely (every non-read-only tool stays unexposed, today's behavior). */
  exposure?: Pick<McpExposureStore, "isNonReadOnlyExposed">
  /** Synchronous identity lookup — both the interactive and headless hosts
   *  keep their plugin registry in memory, so this never needs to be async.
   *  Returns undefined for an unknown pluginId (denies exposure). */
  identityForPlugin?: (pluginId: string) => GrantIdentity | undefined
}
```

```ts
private async shouldExpose(descriptor: RegisteredToolDescriptor): Promise<boolean> {
  if (this.options.exposurePolicy === "all") return true
  if (decideApproval(descriptor.manifestTool.annotations) === "allow") return true
  const identity = this.options.identityForPlugin?.(descriptor.pluginId)
  if (!identity || !this.options.exposure) return false
  return this.options.exposure.isNonReadOnlyExposed(identity)
}
```

`listTools()` becomes:

```ts
async listTools(): Promise<ListToolsResult> {
  const entries = this.refresh()
  const exposed = await Promise.all(
    entries.map(async (entry) => ((await this.shouldExpose(entry.descriptor)) ? entry : undefined))
  )
  return {
    tools: exposed
      .filter((entry): entry is McpToolEntry => entry !== undefined)
      .map((entry) => {
        const tool = entry.descriptor.manifestTool
        return {
          name: entry.safeName,
          title: localizedString(tool.title),
          description: tool.description,
          inputSchema: mcpObjectSchema(tool.inputSchema),
          outputSchema: tool.outputSchema ? mcpObjectSchema(tool.outputSchema) : undefined,
          annotations: mcpAnnotations(tool.annotations),
        }
      }),
  }
}
```

(the `.map(...)` body is unchanged from today's `listTools()` — reproduced here
verbatim so this snippet is directly copy-pasteable, not because it's new.)

`callTool()`'s existing `if (!this.shouldExpose(entry.descriptor))` becomes
`if (!(await this.shouldExpose(entry.descriptor)))` — no other change to
that method.

## 3. Wiring — only one production call site

Only `src/main/mcp/stdio-entry.ts` constructs a real
`SynapseMcpToolService` in production (confirmed — the only other
constructor call site is a safety eval scorer harness, not runtime). Add:

```ts
const exposureStore = new McpExposureStore(mcpExposureFilePath(userDataDir))
// ...
const server = await runSynapseMcpStdioServer(host, {
  // ...existing options...
  exposure: exposureStore,
  identityForPlugin: (pluginId) => {
    const manifest = pluginHost.get(pluginId)?.manifest
    return manifest ? buildGrantIdentity(pluginId, manifest, pluginHost.get(pluginId)!.source.kind) : undefined
  },
})
```

## 4. IPC + Settings UI

Mirrors the `externalMcpPreauthorized` touchpoints from the prior slice
exactly (pure handler → main registration → preload → renderer wrapper),
new channel `capabilities:set-mcp-nonreadonly-exposed`, payload
`{pluginId, value}` (no `capability` field — this is plugin-scoped, not
capability-scoped). `CapabilityIpcService` gains
`isNonReadOnlyExposed(pluginId)`/`setNonReadOnlyExposed(pluginId, value)`,
built the same way `setExternalMcpPreauthorized` resolves an identity via
`buildGrantIdentity` from the plugin's current manifest.

Added inside `plugin-capability-list.tsx` itself (not a new wrapper
component — `PluginCapabilityList` already owns "capability-related state
for this plugin" as a concept, and this is one more piece of it): fetch
`isNonReadOnlyExposed(pluginId)` alongside the existing
`listPluginCapabilities(pluginId)` call in `load()` (`Promise.all`, same
pattern the mcp-client-roots slice used for
`listExecutionWorkspaces()`), store it in a sibling `exposed` state
variable, and render the toggle once, above the `rows.map(...)` list (not
per-row — this is plugin-scoped, the per-capability rows are unaffected):

```tsx
<div className="flex items-center gap-2 pb-2">
  <Switch
    checked={exposed}
    disabled={togglingExposure}
    onCheckedChange={(checked) => void onToggleExposure(checked)}
  />
  <label className="text-xs text-muted-foreground">
    {t("plugins.mcpExposure.toggleLabel")}
  </label>
  <Tooltip>
    <TooltipTrigger asChild>
      <Info className="size-3.5 text-muted-foreground" />
    </TooltipTrigger>
    <TooltipContent>{t("plugins.mcpExposure.warning")}</TooltipContent>
  </Tooltip>
</div>
```

**Bundled in the same change**: convert the existing `preauthorizeWarning`
paragraph (currently always-visible body text under the per-capability
toggle) to the same `Tooltip`-on-an-`Info`-icon pattern, for UI consistency
between the two related toggles now living on the same page. Also shorten
its copy per this session's explicit instruction — drop everything from the
em dash onward:

- en: `"Allows any external MCP client able to launch Synapse's local MCP connection to call this capability without a per-call prompt."`
- zh-CN: `"会允许任何能启动本地 Synapse MCP 连接的外部 MCP client 调用此能力而无需逐次确认。"`

New `plugins.mcpExposure.warning` copy carries the "this is a trust
decision, not just visibility" framing from the Guiding Principle:

- en: `"Turns on external visibility for every non-read-only tool this plugin has (including ones marked destructive). Whether a call still needs per-call confirmation depends on the capability it uses — a tool that uses no managed capability at all would be callable with no prompt."`
- zh-CN: `"打开后，该插件所有非只读工具（含标记为破坏性的）都会对外部 MCP client 可见并可被调用。是否仍需逐次确认取决于该工具用到的能力——如果一个工具完全不使用任何受管能力，打开后将不经确认即可被调用。"`

## 5. Testing strategy

- **`mcp-exposure-store.test.ts`**: mirrors `grant-store.test.ts`'s
  structure — set/read round-trip, default false, identity-hash-rotation
  invalidates (no "must already be granted" precondition test, since this
  store has none, unlike `externalMcpPreauthorized`).
- **`synapse-mcp-server.test.ts`**: extend for the new async
  `shouldExpose` path — a non-read-only tool is excluded when
  `exposure`/`identityForPlugin` are omitted (today's behavior preserved);
  included when `exposure.isNonReadOnlyExposed` resolves true for the
  resolved identity; a `destructiveHint` tool is included under the same
  condition (no extra carve-out); an unknown `pluginId` (no identity
  resolvable) stays excluded even if some other identity is exposed
  (fail-closed on lookup failure, not fail-open).
- **`capabilities.test.ts`**: new `isNonReadOnlyExposed`/
  `setNonReadOnlyExposed` service methods, same shape as the existing
  `setExternalMcpPreauthorized` tests.
- **Renderer**: extend `plugin-capability-list.test.tsx` for the new
  toggle's presence/tooltip content, and update its existing
  preauthorize-warning test to assert the shortened copy renders inside a
  tooltip (not as always-visible text) once that conversion lands.

## 6. Parked questions (surfaced, not solved)

- **Whether `McpToolExposurePolicy`'s `"all"` global value should ever get
  its own config surface** — untouched by this spec; if a future need
  shows up for "expose literally everything from every plugin at once"
  as opposed to per-plugin opt-in, that's a separate small follow-up, not
  a reason to block this slice.
- **A capability-free non-read-only tool actually shipping** — the
  Guiding Principle's caveat is about a currently-hypothetical case (both
  built-in plugins declare capabilities on every tool). Worth a manifest
  lint/warning if it ever becomes real, not designed here.
