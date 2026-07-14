import type { RunDetail, RunSummary } from "@/lib/electron"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { getAiConversation, getRun, isElectron, listAiWorkspaces, listRuns } from "@/lib/electron"

const ORIGINS = ["interactive", "background-agent", "subagent", "mcp"] as const
const OUTCOMES = ["end_turn", "max_steps", "aborted", "budget_exceeded", "error"] as const

function formatDuration(startedAt: number, endedAt: number): string {
  const ms = endedAt - startedAt
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function RunObservatoryPage() {
  const { t } = useTranslation()
  const [summaries, setSummaries] = useState<RunSummary[]>([])
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({})
  const [originFilter, setOriginFilter] = useState<string>("")
  const [outcomeFilter, setOutcomeFilter] = useState<string>("")
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("")
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [detail, setDetail] = useState<RunDetail | undefined>()
  const [conversationExists, setConversationExists] = useState<boolean | undefined>()
  const [parentUnavailable, setParentUnavailable] = useState(false)
  const [childRuns, setChildRuns] = useState<RunSummary[]>([])

  useEffect(() => {
    if (!isElectron()) return
    void listRuns().then(setSummaries)
    // includeArchived: a run recorded against a workspace that has since been
    // archived must still resolve to its real name here, not just its raw id
    // — this is a diagnostic view of history, not a picker of live workspaces.
    void listAiWorkspaces({ includeArchived: true }).then((list) => {
      setWorkspaceNames(Object.fromEntries(list.map((w) => [w.id, w.name])))
    })
  }, [])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(undefined)
      return
    }
    // A response for a run the user has since navigated away from (quick
    // A→B selection) must not clobber the now-current selection's state —
    // guard every setState below on this effect instance still being live.
    let cancelled = false
    setParentUnavailable(false)
    void getRun(selectedRunId).then((result) => {
      if (cancelled) return
      setDetail(result)
      if (result?.conversationId) {
        void getAiConversation(result.conversationId).then((c) => {
          if (!cancelled) setConversationExists(Boolean(c))
        })
      } else {
        setConversationExists(undefined)
      }
      void listRuns({ parentRunId: selectedRunId }).then((rows) => {
        if (!cancelled) setChildRuns(rows)
      })
    })
    return () => {
      cancelled = true
    }
  }, [selectedRunId])

  async function onSelectParent(parentRunId: string) {
    const parent = await getRun(parentRunId)
    if (!parent) {
      setParentUnavailable(true)
      return
    }
    setSelectedRunId(parentRunId)
  }

  const filtered = useMemo(() => {
    return summaries.filter((s) => {
      if (originFilter && s.origin !== originFilter) return false
      if (outcomeFilter && s.outcome !== outcomeFilter) return false
      if (workspaceFilter && s.workspaceId !== workspaceFilter) return false
      return true
    })
  }, [summaries, originFilter, outcomeFilter, workspaceFilter])

  if (!isElectron()) return null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("runObservatory.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("runObservatory.subtitle")}</p>
      </header>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t("runObservatory.filterOrigin")}
          <select
            aria-label="Origin"
            value={originFilter}
            onChange={(e) => setOriginFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t("runObservatory.filterAll")}</option>
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("runObservatory.filterOutcome")}
          <select
            aria-label="Outcome"
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t("runObservatory.filterAll")}</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("runObservatory.filterWorkspace")}
          <select
            aria-label="Workspace"
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t("runObservatory.filterAll")}</option>
            {Object.entries(workspaceNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-80 shrink-0 overflow-y-auto rounded-md border">
          {filtered.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">{t("runObservatory.emptyList")}</p>
          )}
          {filtered.map((s) => (
            <button
              key={s.runId}
              type="button"
              onClick={() => setSelectedRunId(s.runId)}
              className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="font-mono text-xs">{s.runId}</span>
              <span className="text-xs text-muted-foreground">
                {s.origin} · {s.outcome} · {formatDuration(s.startedAt, s.endedAt)} ·{" "}
                {s.toolCallCount} tools ({s.failedToolCallCount} failed)
              </span>
            </button>
          ))}
        </div>

        <div
          data-testid="run-detail-panel"
          className="min-w-0 flex-1 overflow-y-auto rounded-md border p-4"
        >
          {!detail && (
            <p className="text-sm text-muted-foreground">{t("runObservatory.selectPrompt")}</p>
          )}
          {detail && (
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <strong>{t("runObservatory.detailRunId")}:</strong>{" "}
                <span className="font-mono text-xs">{detail.runId}</span>
              </div>
              <div>
                <strong>{t("runObservatory.detailOrigin")}:</strong> {detail.origin}
              </div>
              <div>
                <strong>{t("runObservatory.detailOutcome")}:</strong> {detail.outcome}
              </div>
              <div>
                <strong>{t("runObservatory.detailPrincipal")}:</strong>{" "}
                {detail.principal
                  ? `${detail.principal.kind}${detail.principal.clientId ? ` (${detail.principal.clientId})` : ""}`
                  : "—"}
              </div>
              <div>
                <strong>{t("runObservatory.detailInvocation")}:</strong>{" "}
                {detail.invocationId ? (
                  <span className="font-mono text-xs">{detail.invocationId}</span>
                ) : (
                  "—"
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailStarted")}:</strong>{" "}
                {new Date(detail.startedAt).toLocaleString()}
              </div>
              <div>
                <strong>{t("runObservatory.detailEnded")}:</strong>{" "}
                {new Date(detail.endedAt).toLocaleString()} (
                {formatDuration(detail.startedAt, detail.endedAt)})
              </div>
              <div>
                <strong>{t("runObservatory.detailConversation")}:</strong>{" "}
                {detail.conversationId ? (
                  conversationExists === false ? (
                    <span className="text-muted-foreground">
                      {detail.conversationId} ({t("runObservatory.conversationGone")})
                    </span>
                  ) : (
                    <span>{detail.conversationId}</span>
                  )
                ) : (
                  "—"
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailWorkspace")}:</strong>{" "}
                {detail.workspaceId
                  ? (workspaceNames[detail.workspaceId] ?? detail.workspaceId)
                  : "—"}
              </div>
              <div>
                <strong>{t("runObservatory.detailTrigger")}:</strong>{" "}
                {detail.triggerInstanceId ?? "—"}
              </div>
              <div>
                <strong>{t("runObservatory.detailParentRun")}:</strong>{" "}
                {detail.parentRunId ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onSelectParent(detail.parentRunId!)}
                  >
                    {detail.parentRunId}
                  </button>
                ) : (
                  "—"
                )}
                {parentUnavailable && (
                  <p className="text-xs text-muted-foreground">
                    {t("runObservatory.parentUnavailable")}
                  </p>
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailChildRuns")}:</strong>
                {childRuns.length === 0 ? (
                  <span className="text-muted-foreground"> {t("runObservatory.noChildRuns")}</span>
                ) : (
                  <ul className="ml-4 list-disc">
                    {childRuns.map((c) => (
                      <li key={c.runId}>
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setSelectedRunId(c.runId)}
                        >
                          {c.runId}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <strong>{t("runObservatory.detailToolCalls")}:</strong>
                <ul className="ml-4 list-disc">
                  {detail.toolCalls.map((c, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={`${c.name}-${i}`}>
                      {c.name} — {c.ok ? "ok" : (c.error ?? "error")} ({c.ms}ms)
                    </li>
                  ))}
                </ul>
              </div>
              {detail.plan && detail.plan.length > 0 && (
                <div>
                  <strong>{t("runObservatory.detailPlan")}:</strong>
                  <ul className="ml-4 list-disc">
                    {detail.plan.map((step, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={i}>
                        {step.title} ({step.status})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
