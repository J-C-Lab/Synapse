import type {
  PluginAction,
  PluginActionContext,
  PluginToastView,
  RenderablePluginView,
} from "@/components/plugins/view-renderer"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ViewRenderer } from "@/components/plugins/view-renderer"
import { clipboardText, localize, showPluginToast } from "@/components/plugins/view-utils"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  disposePluginCommand,
  hideLauncher,
  invokePluginCommand,
  launchApp,
  notifyLauncherReady,
  onLauncherFocus,
  searchApps,
  searchPluginCommands,
} from "@/lib/electron"

type LauncherItem =
  | { kind: "app"; value: string; result: LauncherSearchResult }
  | { kind: "plugin"; value: string; result: DeskitPluginCommandResult }

interface ActiveCommand {
  pluginId: string
  commandId: string
  title: DeskitLocalizedString
}

export function LauncherPanel() {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<LauncherItem[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<"search" | "command-view">("search")
  const [activeCommand, setActiveCommand] = useState<ActiveCommand | null>(null)
  const [pluginView, setPluginView] = useState<RenderablePluginView | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestSeqRef = useRef(0)
  const pluginSearchSeqRef = useRef(0)
  const didMountQueryEffectRef = useRef(false)
  const reportedReadyRef = useRef(false)

  // The renderer's <body> defaults to bg-background (opaque white) which
  // bleeds through Electron's transparent launcher window. Force html/body
  // transparent while this panel is mounted so the popover is the only
  // painted surface.
  useLayoutEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prev = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
    }
    html.style.background = "transparent"
    body.style.background = "transparent"
    html.style.overflow = "hidden"
    body.style.overflow = "hidden"
    return () => {
      html.style.background = prev.htmlBg
      body.style.background = prev.bodyBg
      html.style.overflow = prev.htmlOverflow
      body.style.overflow = prev.bodyOverflow
    }
  }, [])

  // cmdk does its own client-side filtering by default; we already filter
  // in main using fuzzy scoring, so we disable cmdk's filter and pass the
  // backend results straight through.
  const items = useMemo(() => results, [results])

  const runSearch = useCallback(
    async (next: string) => {
      const seq = ++requestSeqRef.current
      setLoading(true)
      try {
        const [apps, commands] = await Promise.all([
          searchApps(next),
          searchPluginCommands(next, i18n.language, 8).catch((err) => {
            console.error("searchPluginCommands failed", err)
            return []
          }),
        ])
        if (seq === requestSeqRef.current) {
          setResults([
            ...commands.map((result) => ({
              kind: "plugin" as const,
              value: `plugin:${result.pluginId}:${result.commandId}`,
              result,
            })),
            ...apps.map((result) => ({
              kind: "app" as const,
              value: `app:${result.entry.id}`,
              result,
            })),
          ])
        }
      } finally {
        if (seq === requestSeqRef.current) setLoading(false)
      }
    },
    [i18n.language]
  )

  // Initial population — empty query returns the first slice of installed apps.
  useEffect(() => {
    void runSearch("")
  }, [runSearch])

  // Debounce keystrokes — typing fast through "Visual Studio Code" should
  // not fire eight IPC round-trips.
  useEffect(() => {
    if (!didMountQueryEffectRef.current) {
      didMountQueryEffectRef.current = true
      return
    }

    const handle = window.setTimeout(() => {
      void runSearch(query)
    }, 80)
    return () => window.clearTimeout(handle)
  }, [query, runSearch])

  useEffect(() => {
    if (loading || reportedReadyRef.current) return
    reportedReadyRef.current = true
    notifyLauncherReady()
  }, [loading])

  // Reset state every time the launcher window regains focus so the user
  // starts from a clean slate instead of stale text from a previous summon.
  useEffect(() => {
    const cleanup = onLauncherFocus(() => {
      setQuery("")
      setMode("search")
      setActiveCommand(null)
      setPluginView(null)
      inputRef.current?.focus()
    })
    return cleanup
  }, [])

  // Keep the input focused; the frameless window otherwise loses focus on
  // mount if cmdk steals it during list rendering.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const closePluginView = useCallback(async () => {
    const command = activeCommand
    setMode("search")
    setActiveCommand(null)
    setPluginView(null)
    inputRef.current?.focus()
    if (command) {
      try {
        await disposePluginCommand(command.pluginId, command.commandId)
      } catch (err) {
        console.error("disposePluginCommand failed", err)
      }
    }
  }, [activeCommand])

  const invokeActiveCommand = useCallback(
    async (text: string) => {
      if (!activeCommand) return
      const seq = ++pluginSearchSeqRef.current
      try {
        const next = await invokePluginCommand(
          activeCommand.pluginId,
          activeCommand.commandId,
          "onSearchChange",
          text
        )
        if (seq === pluginSearchSeqRef.current && next) {
          setPluginView(next as RenderablePluginView)
        }
      } catch (err) {
        console.error("plugin onSearchChange failed", err)
        toast.error("Command search failed")
      }
    },
    [activeCommand]
  )

  const runPluginCommand = useCallback(
    async (command: DeskitPluginCommandResult) => {
      try {
        const view = await invokePluginCommand(command.pluginId, command.commandId, "run", {
          initialQuery: query,
        })
        if (isPluginToastView(view)) {
          showPluginToast(view, i18n.language)
          if (command.mode === "no-view") return
        }
        if (command.mode === "no-view") {
          void hideLauncher()
          return
        }
        setActiveCommand({
          pluginId: command.pluginId,
          commandId: command.commandId,
          title: command.title,
        })
        setPluginView((view ?? { type: "list", items: [] }) as RenderablePluginView)
        setMode("command-view")
      } catch (err) {
        console.error("invokePluginCommand failed", err)
        toast.error("Command failed")
      }
    },
    [i18n.language, query]
  )

  const onSelect = useCallback(
    async (value: string) => {
      const item = items.find((candidate) => candidate.value === value)
      if (!item) return
      try {
        if (item.kind === "app") {
          await launchApp(item.result.entry.id)
        } else {
          await runPluginCommand(item.result)
        }
      } catch (err) {
        console.error("launcher selection failed", err)
      }
    },
    [items, runPluginCommand]
  )

  const onPluginAction = useCallback(
    async (action: PluginAction, context: PluginActionContext) => {
      if (action.type === "copy" || action.type === "paste") {
        await navigator.clipboard.writeText(clipboardText(action.value))
        toast.success(action.type === "copy" ? "Copied" : "Copied for paste")
        if (action.type === "paste") void hideLauncher()
        return
      }
      if (action.type === "open-url") {
        window.open(action.url, "_blank", "noopener,noreferrer")
        return
      }
      if (action.type === "open-path") {
        await navigator.clipboard.writeText(action.path)
        toast.success("Path copied")
        return
      }
      if (action.type === "close") {
        await closePluginView()
        return
      }
      if (!activeCommand) return

      if (action.type === "run-command") {
        const next = await invokePluginCommand(activeCommand.pluginId, action.commandId, "run", {
          args: action.args,
        })
        if (next) {
          setActiveCommand({
            pluginId: activeCommand.pluginId,
            commandId: action.commandId,
            title: action.label ?? action.commandId,
          })
          setPluginView(next as RenderablePluginView)
        }
        return
      }

      const payload =
        action.type === "custom"
          ? { actionId: action.id, payload: action.payload, item: context.item }
          : { actionId: "submit", payload: context.values }
      const next = await invokePluginCommand(
        activeCommand.pluginId,
        activeCommand.commandId,
        "onAction",
        payload
      )
      if (isPluginToastView(next)) showPluginToast(next, i18n.language)
      else if (next) setPluginView(next as RenderablePluginView)
    },
    [activeCommand, closePluginView, i18n.language]
  )

  // Escape: hide. Up/Down/Enter handled by cmdk.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (mode === "command-view") void closePluginView()
        else void hideLauncher()
      }
    },
    [closePluginView, mode]
  )

  return (
    <div className="flex h-screen w-screen flex-col" onKeyDown={onKeyDown}>
      <Command
        shouldFilter={false}
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        {mode === "command-view" && activeCommand && pluginView ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-3 py-2">
              <div className="truncate text-sm font-medium">
                {localize(activeCommand.title, i18n.language)}
              </div>
            </div>
            <ViewRenderer
              view={pluginView}
              onAction={onPluginAction}
              onSearchChange={invokeActiveCommand}
              onClose={closePluginView}
              className="min-h-0 flex-1"
            />
          </div>
        ) : (
          <>
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder={t("launcher.placeholder")}
            />
            <CommandList className="max-h-none flex-1">
              {!loading && items.length === 0 && <CommandEmpty>{t("launcher.empty")}</CommandEmpty>}
              <CommandGroup heading={t("launcher.commands")}>
                {items
                  .filter((item) => item.kind === "plugin")
                  .map((item) => (
                    <CommandItem
                      key={item.value}
                      value={item.value}
                      onSelect={() => onSelect(item.value)}
                    >
                      <LauncherPluginItem item={item.result} locale={i18n.language} />
                    </CommandItem>
                  ))}
              </CommandGroup>
              <CommandGroup heading={t("launcher.installed")}>
                {items
                  .filter((item) => item.kind === "app")
                  .map((item) => (
                    <CommandItem
                      key={item.value}
                      value={item.value}
                      onSelect={() => onSelect(item.value)}
                    >
                      <div className="flex flex-1 flex-col">
                        <span className="text-sm">{item.result.entry.name}</span>
                        {item.result.entry.description && (
                          <span className="text-xs text-muted-foreground">
                            {item.result.entry.description}
                          </span>
                        )}
                      </div>
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {t(`launcher.kind.${item.result.entry.kind}`)}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </>
        )}
      </Command>
    </div>
  )
}

function isPluginToastView(value: unknown): value is PluginToastView {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.type === "toast" &&
    typeof record.level === "string" &&
    typeof record.message !== "undefined"
  )
}

function LauncherPluginItem({ item, locale }: { item: DeskitPluginCommandResult; locale: string }) {
  return (
    <>
      <div className="flex flex-1 flex-col">
        <span className="text-sm">{localize(item.title, locale)}</span>
        {item.subtitle && (
          <span className="text-xs text-muted-foreground">{localize(item.subtitle, locale)}</span>
        )}
      </div>
      <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase text-primary">
        {item.mode === "view" ? "Command" : "Run"}
      </span>
    </>
  )
}
