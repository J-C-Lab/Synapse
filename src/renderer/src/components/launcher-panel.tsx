import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { hideLauncher, launchApp, onLauncherFocus, searchApps } from "@/lib/electron"

const KIND_LABEL: Record<LauncherAppKind, string> = {
  win32: "App",
  uwp: "Store",
  url: "Web",
}

export function LauncherPanel() {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<LauncherSearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestSeqRef = useRef(0)

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
    const handle = window.setTimeout(() => {
      void runSearch(query)
    }, 80)
    return () => window.clearTimeout(handle)
  }, [query, runSearch])

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
    <div
      className="flex h-screen w-screen items-start justify-center bg-transparent pt-0"
      onKeyDown={onKeyDown}
    >
      <Command
        shouldFilter={false}
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <CommandInput
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          placeholder={t("launcher.placeholder")}
        />
        <CommandList className="max-h-[60vh]">
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
                  {KIND_LABEL[item.entry.kind]}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
