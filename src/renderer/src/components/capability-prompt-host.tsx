import type {
  ApprovalSettledEvent,
  CapabilityApprovalRequestEvent,
  CapabilityGrantRequestEvent,
  HostResourceApprovalRequestEvent,
} from "@/lib/electron"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PluginCapabilityProfileCard } from "@/components/plugins/plugin-capability-profile"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useCapabilityProfile } from "@/hooks/use-capability-profile"
import {
  isElectron,
  onApprovalSettled,
  onCapabilityApprovalRequest,
  onCapabilityGrantRequest,
  onHostResourceApprovalRequest,
  resolveCapabilityApproval,
  resolveCapabilityGrant,
  resolveHostResourceApproval,
} from "@/lib/electron"

type PendingPrompt =
  | ({ kind: "grant" } & CapabilityGrantRequestEvent)
  | ({ kind: "approval" } & CapabilityApprovalRequestEvent)
  | ({ kind: "host-resource" } & HostResourceApprovalRequestEvent)

/** How long the transient "request cancelled" notice stays up before the queue auto-advances. */
const CANCELLED_NOTICE_MS = 1800

/** How long a settled id is remembered so a late/duplicate request for it is dropped on arrival. */
const SETTLED_TOMBSTONE_MS = 30_000

/** Outcomes that mean "nobody answered" — as opposed to a human explicitly allowing/denying. */
const CANCEL_LIKE_OUTCOMES = new Set<ApprovalSettledEvent["outcome"]>([
  "cancelled",
  "gui-disposed",
  "send-failed",
  "timed-out",
  "client-disconnected",
])

function toPendingKind(kind: ApprovalSettledEvent["kind"]): PendingPrompt["kind"] {
  if (kind === "capability-grant") return "grant"
  if (kind === "capability-approval") return "approval"
  return "host-resource"
}

export function CapabilityPromptHost() {
  const { t } = useTranslation()
  const queueRef = useRef<PendingPrompt[]>([])
  const pendingRef = useRef<PendingPrompt | null>(null)
  const settledIdsRef = useRef<Map<string, number>>(new Map())
  const cancelledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelledNotice, setCancelledNotice] = useState(false)
  const pluginId = pending?.kind === "host-resource" ? undefined : pending?.pluginId
  const profile = useCapabilityProfile(pluginId)

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  useEffect(
    () => () => {
      if (cancelledTimerRef.current) clearTimeout(cancelledTimerRef.current)
    },
    []
  )

  const pruneSettledIds = useCallback(() => {
    const now = Date.now()
    for (const [id, settledAt] of settledIdsRef.current) {
      if (now - settledAt > SETTLED_TOMBSTONE_MS) settledIdsRef.current.delete(id)
    }
  }, [])

  const removeById = useCallback((promptId: string) => {
    const wasShown = queueRef.current[0]?.promptId === promptId
    queueRef.current = queueRef.current.filter((item) => item.promptId !== promptId)
    if (!wasShown) return
    // The shown prompt is advancing (or the dialog is closing) — any cancellation
    // notice/timer tied to the prompt being removed no longer applies.
    if (cancelledTimerRef.current) {
      clearTimeout(cancelledTimerRef.current)
      cancelledTimerRef.current = null
    }
    setCancelledNotice(false)
    setPending(queueRef.current[0] ?? null)
  }, [])

  const enqueue = useCallback(
    (item: PendingPrompt) => {
      pruneSettledIds()
      if (settledIdsRef.current.has(item.promptId)) return
      queueRef.current.push(item)
      setPending((current) => current ?? item)
    },
    [pruneSettledIds]
  )

  useEffect(() => {
    if (!isElectron()) return
    const offGrant = onCapabilityGrantRequest((event) => enqueue({ kind: "grant", ...event }))
    const offApproval = onCapabilityApprovalRequest((event) =>
      enqueue({ kind: "approval", ...event })
    )
    const offHostResource = onHostResourceApprovalRequest((event) =>
      enqueue({ kind: "host-resource", ...event })
    )
    const offSettled = onApprovalSettled((event) => {
      settledIdsRef.current.set(event.id, Date.now())
      pruneSettledIds()

      const shown = pendingRef.current
      const isShown = shown?.promptId === event.id && shown.kind === toPendingKind(event.kind)
      if (!isShown || !CANCEL_LIKE_OUTCOMES.has(event.outcome)) {
        removeById(event.id)
        return
      }

      // The prompt currently on screen was settled by something other than a
      // click here (cancelled upstream, the caller disconnected, it timed out,
      // etc). Rather than yanking the dialog away instantly, show a brief
      // "request cancelled" notice, then advance the queue.
      setCancelledNotice(true)
      if (cancelledTimerRef.current) clearTimeout(cancelledTimerRef.current)
      cancelledTimerRef.current = setTimeout(() => {
        cancelledTimerRef.current = null
        removeById(event.id)
      }, CANCELLED_NOTICE_MS)
    })
    return () => {
      offGrant()
      offApproval()
      offHostResource()
      offSettled()
    }
  }, [enqueue, pruneSettledIds, removeById])

  async function respond(allow: boolean) {
    if (!pending || busy || cancelledNotice) return
    setBusy(true)
    try {
      if (pending.kind === "grant") {
        await resolveCapabilityGrant(pending.promptId, allow)
      } else if (pending.kind === "approval") {
        await resolveCapabilityApproval(pending.promptId, allow)
      } else {
        await resolveHostResourceApproval(pending.promptId, allow)
      }
    } finally {
      setBusy(false)
      removeById(pending.promptId)
    }
  }

  const capabilityLabel =
    pending && pending.kind !== "host-resource"
      ? t(`permissions.items.${pending.capability}`, {
          defaultValue: pending.capability,
          nsSeparator: false,
        })
      : ""

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && pending && !cancelledNotice) void respond(false)
      }}
    >
      <DialogContent>
        {cancelledNotice ? (
          <DialogHeader>
            <DialogTitle>{t("plugins.capabilities.requestCancelledTitle")}</DialogTitle>
            <DialogDescription>{t("plugins.capabilities.requestCancelledBody")}</DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {pending?.kind === "host-resource"
                  ? t("plugins.hostResources.approvalTitle")
                  : pending?.kind === "approval"
                    ? t("plugins.capabilities.approvalTitle")
                    : t("plugins.capabilities.grantTitle")}
              </DialogTitle>
              <DialogDescription>
                {pending?.kind === "host-resource"
                  ? t("plugins.hostResources.approvalBody", {
                      resourceLabel: pending.resourceType,
                      workspaceName: pending.workspaceName,
                      rootName: pending.rootName,
                    })
                  : pending?.kind === "approval"
                    ? t("plugins.capabilities.approvalBody", {
                        plugin: pending.pluginId,
                        capability: capabilityLabel,
                        actor: pending.actor,
                        operation: pending.operation,
                      })
                    : t("plugins.capabilities.grantBody", {
                        plugin: pending?.pluginId ?? "",
                        capability: capabilityLabel,
                        tier: pending?.tier ?? "",
                      })}
              </DialogDescription>
            </DialogHeader>
            {profile ? <PluginCapabilityProfileCard profile={profile} /> : null}
            {pending?.kind === "approval" && pending.clientId ? (
              <p className="text-xs text-muted-foreground">
                {t("plugins.capabilities.reportedIdentity", { clientId: pending.clientId })}
              </p>
            ) : null}
            {pending?.kind === "host-resource" && pending.clientId ? (
              <p className="text-xs text-muted-foreground">
                {t("plugins.hostResources.reportedIdentity", { clientId: pending.clientId })}
              </p>
            ) : null}
            {pending?.reason ? (
              <p className="text-sm text-muted-foreground">{pending.reason}</p>
            ) : null}
            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" disabled={busy} onClick={() => void respond(false)}>
                {t("plugins.capabilities.deny")}
              </Button>
              <Button disabled={busy} onClick={() => void respond(true)}>
                {t("plugins.capabilities.allow")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
