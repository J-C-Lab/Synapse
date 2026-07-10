import type {
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

export function CapabilityPromptHost() {
  const { t } = useTranslation()
  const queueRef = useRef<PendingPrompt[]>([])
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const [busy, setBusy] = useState(false)
  const pluginId = pending?.kind === "host-resource" ? undefined : pending?.pluginId
  const profile = useCapabilityProfile(pluginId)

  const dequeue = useCallback(() => {
    queueRef.current.shift()
    setPending(queueRef.current[0] ?? null)
  }, [])

  const enqueue = useCallback((item: PendingPrompt) => {
    queueRef.current.push(item)
    setPending((current) => current ?? item)
  }, [])

  useEffect(() => {
    if (!isElectron()) return
    const offGrant = onCapabilityGrantRequest((event) => enqueue({ kind: "grant", ...event }))
    const offApproval = onCapabilityApprovalRequest((event) =>
      enqueue({ kind: "approval", ...event })
    )
    const offHostResource = onHostResourceApprovalRequest((event) =>
      enqueue({ kind: "host-resource", ...event })
    )
    return () => {
      offGrant()
      offApproval()
      offHostResource()
    }
  }, [enqueue])

  async function respond(allow: boolean) {
    if (!pending || busy) return
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
      dequeue()
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
        if (!open && pending) void respond(false)
      }}
    >
      <DialogContent>
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
        {pending?.reason ? <p className="text-sm text-muted-foreground">{pending.reason}</p> : null}
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" disabled={busy} onClick={() => void respond(false)}>
            {t("plugins.capabilities.deny")}
          </Button>
          <Button disabled={busy} onClick={() => void respond(true)}>
            {t("plugins.capabilities.allow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
