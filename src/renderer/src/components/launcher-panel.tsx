import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  hideLauncher,
  launchApp,
  notifyLauncherReady,
  onLauncherFocus,
  searchApps,
} from "@/lib/electron"

export function LauncherPanel() {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<LauncherSearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestSeqRef = useRef(0)
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
  const items = useMemo(() => results.map((r) => ({ ...r, value: r.entry.id })), [results])

  const runSearch = useCallback(async (next: string) => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    try {
      const list = await searchApps(next)
      if (seq === requestSeqRef.current) setResults(list)
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [])

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
      inputRef.current?.focus()
    })
    return cleanup
  }, [])

  // Keep the input focused; the frameless window otherwise loses focus on
  // mount if cmdk steals it during list rendering.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const onSelect = useCallback(async (id: string) => {
    try {
      await launchApp(id)
    } catch (err) {
      console.error("launchApp failed", err)
    }
  }, [])

  // Escape: hide. Up/Down/Enter handled by cmdk.
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      void hideLauncher()
    }
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col" onKeyDown={onKeyDown}>
      <Command
        shouldFilter={false}
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <CommandInput
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          placeholder={t("launcher.placeholder")}
        />
        <CommandList className="max-h-none flex-1">
          {!loading && items.length === 0 && <CommandEmpty>{t("launcher.empty")}</CommandEmpty>}
          <CommandGroup heading={t("launcher.installed")}>
            {items.map((item) => (
              <CommandItem
                key={item.entry.id}
                value={item.entry.id}
                onSelect={() => onSelect(item.entry.id)}
              >
                <div className="flex flex-1 flex-col">
                  <span className="text-sm">{item.entry.name}</span>
                  {item.entry.description && (
                    <span className="text-xs text-muted-foreground">{item.entry.description}</span>
                  )}
                </div>
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {t(`launcher.kind.${item.entry.kind}`)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
