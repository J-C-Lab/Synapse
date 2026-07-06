import type { CSSProperties, RefObject } from "react"
import type { LanDevice, LanPairing, LanStatus, LanTransfer } from "@/lib/electron"
import { REGEXP_ONLY_DIGITS } from "input-otp"
import {
  AlertCircle,
  Check,
  FileUp,
  HelpCircle,
  Laptop,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unplug,
  Wifi,
  X,
} from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  acceptLanTransfer,
  confirmLanPairing,
  disconnectLanDevice,
  getLanStatus,
  isElectron,
  listLanDevices,
  listLanPairings,
  listLanTransfers,
  onLanDevicesChanged,
  onLanPairingsChanged,
  onLanStatusChanged,
  onLanTransfersChanged,
  pairLanDevice,
  rejectLanPairing,
  rejectLanTransfer,
  removeLanTransferHistory,
  resumeLanTransfer,
  sendLanFile,
  updateSettings,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

const LAN_SECURITY_GUIDE_SEEN_KEY = "synapse:lan-security-guide-seen"

export function LanTransferPage() {
  const { t } = useTranslation()
  const electronReady = isElectron()
  const [status, setStatus] = useState<LanStatus | null>(null)
  const [devices, setDevices] = useState<LanDevice[]>([])
  const [pairings, setPairings] = useState<LanPairing[]>([])
  const [transfers, setTransfers] = useState<LanTransfer[]>([])
  const [loading, setLoading] = useState(electronReady)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const devicesRef = useRef<HTMLElement>(null)

  const load = useCallback(async () => {
    if (!electronReady) return
    setLoading(true)
    setError(null)
    try {
      const [nextStatus, nextDevices, nextPairings, nextTransfers] = await Promise.all([
        getLanStatus(),
        listLanDevices(),
        listLanPairings(),
        listLanTransfers(),
      ])
      setStatus(nextStatus)
      setDevices(nextDevices)
      setPairings(nextPairings)
      setTransfers(nextTransfers)
    } catch (err) {
      setError(errorMessage(err, t("lan.restartRequired")))
    } finally {
      setLoading(false)
    }
  }, [electronReady, t])

  useEffect(() => {
    if (!electronReady) return
    void load()
    const unsubscribeDevices = onLanDevicesChanged(setDevices)
    const unsubscribeStatus = onLanStatusChanged(setStatus)
    const unsubscribePairings = onLanPairingsChanged(setPairings)
    const unsubscribeTransfers = onLanTransfersChanged(setTransfers)
    return () => {
      unsubscribeDevices()
      unsubscribeStatus()
      unsubscribePairings()
      unsubscribeTransfers()
    }
  }, [electronReady, load])

  async function toggleDiscovery(enabled: boolean) {
    setPending(true)
    setError(null)
    try {
      await updateSettings({ lanEnabled: enabled })
      setStatus(await getLanStatus())
    } catch (err) {
      setError(errorMessage(err, t("lan.restartRequired")))
    } finally {
      setPending(false)
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err, t("lan.restartRequired")))
    } finally {
      setPending(false)
    }
  }

  const awaitingPairings = pairings.filter((pairing) => pairing.state === "awaiting-confirmation")
  const incomingPairings = awaitingPairings.filter((pairing) => pairing.direction === "incoming")
  const outgoingPairings = awaitingPairings.filter((pairing) => pairing.direction === "outgoing")

  if (!electronReady) {
    return (
      <PageFrame>
        <Alert>
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t("lan.unavailableTitle")}</AlertTitle>
          <AlertDescription>{t("lan.unavailableBody")}</AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  return (
    <PageFrame
      action={
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
          {t("lan.actions.refresh")}
        </Button>
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t("lan.errorTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <SecurityGuide targetRef={devicesRef} />

      <Card>
        <CardHeader>
          <CardTitle>{t("lan.discovery.title")}</CardTitle>
          <CardDescription>{t("lan.discovery.subtitle")}</CardDescription>
          <CardAction>
            <Switch
              checked={status?.enabled ?? false}
              disabled={pending || loading}
              aria-label={t("lan.discovery.enable")}
              onCheckedChange={(enabled) => void toggleDiscovery(enabled)}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Wifi className="size-4 text-muted-foreground" aria-hidden />
            <span>{t(status?.discovering ? "lan.status.browsing" : "lan.status.stopped")}</span>
          </div>
          {status?.localDeviceName && (
            <div className="rounded-md bg-muted px-3 py-2 text-muted-foreground">
              <p>{t("lan.localDevice", { name: status.localDeviceName })}</p>
              <p className="mt-1 break-all font-mono text-xs">{status.localDeviceId}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <section ref={devicesRef} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t("lan.devices.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("lan.devices.subtitle")}</p>
          </div>
          <Badge variant="secondary">
            {t("lan.devices.online", { count: status?.deviceCount ?? 0 })}
          </Badge>
        </div>

        {loading ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("lan.loading")}</CardTitle>
            </CardHeader>
          </Card>
        ) : devices.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("lan.devices.emptyTitle")}</CardTitle>
              <CardDescription>{t("lan.devices.emptyBody")}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {devices.map((device) => (
              <DeviceCard
                key={device.deviceId}
                device={device}
                disabled={pending}
                onDisconnect={() => mutate(() => disconnectLanDevice(device.deviceId))}
                onPair={() => mutate(() => pairLanDevice(device.deviceId))}
                onSend={() => mutate(() => sendLanFile(device.deviceId))}
              />
            ))}
          </div>
        )}
      </section>

      {incomingPairings.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t("lan.pairings.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("lan.pairings.subtitle")}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {incomingPairings.map((pairing) => (
              <IncomingPairingCard
                key={pairing.id}
                pairing={pairing}
                disabled={pending}
                onReject={() => mutate(() => rejectLanPairing(pairing.id))}
              />
            ))}
          </div>
        </section>
      )}

      {outgoingPairings.map((pairing) => (
        <OutgoingPairingDialog
          key={pairing.id}
          pairing={pairing}
          disabled={pending}
          onConfirm={(sas) => confirmLanPairing(pairing.id, sas)}
          onCancel={() => mutate(() => rejectLanPairing(pairing.id))}
        />
      ))}

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("lan.transfers.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("lan.transfers.subtitle")}</p>
        </div>
        {transfers.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("lan.transfers.emptyTitle")}</CardTitle>
              <CardDescription>{t("lan.transfers.emptyBody")}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {transfers.map((transfer) => (
              // eslint-disable-next-line ts/no-use-before-define
              <TransferCard
                key={transfer.id}
                transfer={transfer}
                disabled={pending}
                onAccept={() => mutate(() => acceptLanTransfer(transfer.id))}
                onReject={() => mutate(() => rejectLanTransfer(transfer.id))}
                onRemove={() => mutate(() => removeLanTransferHistory(transfer.id))}
                onResume={() => mutate(() => resumeLanTransfer(transfer.id))}
              />
            ))}
          </div>
        )}
      </section>
    </PageFrame>
  )
}

interface GuideRect {
  bottom: number
  height: number
  left: number
  top: number
  width: number
}

function SecurityGuide({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(() => !hasSeenSecurityGuide())
  const [collapsing, setCollapsing] = useState(false)
  const [targetRect, setTargetRect] = useState<GuideRect | null>(null)

  useEffect(() => {
    if (!collapsing) return
    const timeoutId = window.setTimeout(setCollapsing, 350, false)
    return () => window.clearTimeout(timeoutId)
  }, [collapsing])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    setCollapsing(!nextOpen)
    if (!nextOpen) markSecurityGuideSeen()
  }, [])

  const updateTargetRect = useCallback(() => {
    if (!targetRef.current) return
    const rect = targetRef.current.getBoundingClientRect()
    const inset = 8
    const left = Math.max(inset, rect.left - inset)
    const top = Math.max(inset, rect.top - inset)
    const right = Math.min(window.innerWidth - inset, rect.right + inset)
    const bottom = Math.min(window.innerHeight - inset, rect.bottom + inset)
    setTargetRect({
      bottom,
      height: Math.max(0, bottom - top),
      left,
      top,
      width: Math.max(0, right - left),
    })
  }, [targetRef])

  useEffect(() => {
    if (!open) return
    const animationFrameId = window.requestAnimationFrame(updateTargetRect)
    const target = targetRef.current
    const resizeObserver =
      target && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateTargetRect)
        : undefined
    if (target) resizeObserver?.observe(target)
    window.addEventListener("resize", updateTargetRect)
    window.addEventListener("scroll", updateTargetRect, true)
    return () => {
      resizeObserver?.disconnect()
      window.cancelAnimationFrame(animationFrameId)
      window.removeEventListener("resize", updateTargetRect)
      window.removeEventListener("scroll", updateTargetRect, true)
    }
  }, [open, targetRef, updateTargetRect])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") handleOpenChange(false)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleOpenChange, open])

  return (
    <>
      {open && targetRect && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label={t("lan.actions.dismissGuideOverlay")}
            onClick={() => handleOpenChange(false)}
          />
          <div
            data-testid="lan-security-guide-spotlight"
            className="lan-security-guide-spotlight pointer-events-none fixed z-50 rounded-lg border-2 border-primary"
            style={{
              height: targetRect.height,
              left: targetRect.left,
              top: targetRect.top,
              width: targetRect.width,
            }}
            aria-hidden
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="lan-security-guide-title"
            aria-describedby="lan-security-guide-body"
            className="fixed z-[60] w-[min(26rem,calc(100vw-2rem))] rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl"
            style={guideCalloutStyle(targetRect)}
          >
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ShieldCheck className="size-5" aria-hidden />
              </div>
              <div className="flex flex-col gap-2">
                <h2 id="lan-security-guide-title" className="font-semibold">
                  {t("lan.securityTitle")}
                </h2>
                <p id="lan-security-guide-body" className="text-sm leading-6 text-muted-foreground">
                  {t("lan.securityBody")}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => handleOpenChange(false)}>
                {t("lan.actions.dismissGuide")}
              </Button>
            </div>
          </section>
        </>
      )}

      {!open && collapsing && (
        <div
          className="lan-security-guide-collapse fixed right-6 bottom-6 z-[60] flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
          aria-hidden
        >
          <HelpCircle className="size-5" />
        </div>
      )}

      {!open && !collapsing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="fixed right-6 bottom-6 z-40 size-10 animate-in rounded-full shadow-lg fade-in-0 zoom-in-50 slide-in-from-bottom-3 duration-300"
              size="icon"
              aria-label={t("lan.securityHelp")}
              onClick={() => handleOpenChange(true)}
            >
              <HelpCircle className="size-5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("lan.securityHelp")}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

function guideCalloutStyle(targetRect: GuideRect): CSSProperties {
  const calloutWidth = Math.min(416, window.innerWidth - 32)
  const calloutHeight = 210
  const gap = 16
  const left = clamp(targetRect.left, gap, window.innerWidth - calloutWidth - gap)
  const below = targetRect.bottom + gap
  const top =
    below + calloutHeight <= window.innerHeight
      ? below
      : Math.max(gap, targetRect.top - calloutHeight - gap)
  return { left, top }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function DeviceCard({
  device,
  disabled,
  onDisconnect,
  onPair,
  onSend,
}: {
  device: LanDevice
  disabled: boolean
  onDisconnect: () => void
  onPair: () => void
  onSend: () => void
}) {
  const { t } = useTranslation()
  const reachable = isDeviceReachable(device)
  const statusKey = device.online
    ? "lan.status.online"
    : device.reachable
      ? "lan.status.reachable"
      : "lan.status.offline"
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Laptop className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>{device.name}</CardTitle>
        </div>
        <CardDescription>{device.addresses[0] ?? device.host}</CardDescription>
        <CardAction>
          <Badge variant={device.online ? "default" : device.reachable ? "secondary" : "outline"}>
            {t(statusKey)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden />
          <span>{t(device.paired ? "lan.status.paired" : "lan.status.unpaired")}</span>
        </div>
        <p>{t("lan.devices.platform", { platform: device.platform })}</p>
        {device.discoverySource && <p>{t(`lan.devices.source.${device.discoverySource}`)}</p>}
        <div className="flex gap-2 pt-2">
          {device.paired ? (
            <>
              <Button size="sm" disabled={disabled || !reachable} onClick={onSend}>
                <FileUp className="size-4" aria-hidden />
                {t("lan.actions.sendFile")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !reachable}
                onClick={onDisconnect}
              >
                <Unplug className="size-4" aria-hidden />
                {t("lan.actions.disconnect")}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={disabled || !reachable} onClick={onPair}>
              <ShieldCheck className="size-4" aria-hidden />
              {t("lan.actions.pair")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function isDeviceReachable(device: LanDevice): boolean {
  return Boolean(device.online || device.reachable)
}

function IncomingPairingCard({
  pairing,
  disabled,
  onReject,
}: {
  pairing: LanPairing
  disabled: boolean
  onReject: () => void
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{pairing.deviceName}</CardTitle>
        <CardDescription>{t("lan.pairings.incoming")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-md bg-muted px-4 py-3 text-center">
          <p className="text-xs text-muted-foreground">{t("lan.pairings.sas")}</p>
          <p className="mt-1 font-mono text-3xl font-semibold tracking-[0.3em]">{pairing.sas}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t("lan.pairings.showCodeHint")}</p>
        <div className="flex">
          <Button size="sm" variant="outline" disabled={disabled} onClick={onReject}>
            <X className="size-4" aria-hidden />
            {t("lan.actions.reject")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function OutgoingPairingDialog({
  pairing,
  disabled,
  onConfirm,
  onCancel,
}: {
  pairing: LanPairing
  disabled: boolean
  onConfirm: (sas: string) => Promise<unknown>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (code.length < 6 || submitting || disabled) return
    setSubmitting(true)
    setError(null)
    try {
      await onConfirm(code)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCode("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("lan.pairings.enterCodeTitle")}</DialogTitle>
          <DialogDescription>
            {t("lan.pairings.enterCodeBody", { name: pairing.deviceName })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <InputOTP
            autoFocus
            maxLength={6}
            pattern={REGEXP_ONLY_DIGITS}
            inputMode="numeric"
            value={code}
            disabled={submitting || disabled}
            onChange={setCode}
            onComplete={() => void submit()}
            containerClassName="justify-center"
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  className="h-12 w-10 text-lg"
                  aria-invalid={Boolean(error)}
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            <X className="size-4" aria-hidden />
            {t("lan.actions.reject")}
          </Button>
          <Button
            disabled={code.length < 6 || submitting || disabled}
            onClick={() => void submit()}
          >
            <Check className="size-4" aria-hidden />
            {t("lan.actions.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const TransferCard = memo(
  ({
    transfer,
    disabled,
    onAccept,
    onReject,
    onRemove,
    onResume,
  }: {
    transfer: LanTransfer
    disabled: boolean
    onAccept: () => void
    onReject: () => void
    onRemove: () => void
    onResume: () => void
  }) => {
    const { t } = useTranslation()
    const progress = transfer.size === 0 ? 100 : (transfer.transferredBytes / transfer.size) * 100
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Card>
            <CardHeader>
              <CardTitle>{transfer.fileName}</CardTitle>
              <CardDescription>
                {t(`lan.transfers.${transfer.direction}`, { name: transfer.deviceName })}
              </CardDescription>
              <CardAction>
                <Badge variant="outline">{t(`lan.transfers.state.${transfer.state}`)}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                {t("lan.transfers.progress", {
                  current: formatBytes(transfer.transferredBytes),
                  total: formatBytes(transfer.size),
                })}
              </p>
              {transfer.error && <p className="text-xs text-destructive">{transfer.error}</p>}
              <div className="flex gap-2">
                {transfer.direction === "outgoing" && transfer.state === "paused" && (
                  <Button size="sm" disabled={disabled} onClick={onResume}>
                    <RotateCcw className="size-4" aria-hidden />
                    {t("lan.actions.resume")}
                  </Button>
                )}
                {transfer.direction === "incoming" &&
                  transfer.state === "awaiting-confirmation" && (
                    <>
                      <Button size="sm" disabled={disabled} onClick={onAccept}>
                        <Check className="size-4" aria-hidden />
                        {t("lan.actions.accept")}
                      </Button>
                      <Button size="sm" variant="outline" disabled={disabled} onClick={onReject}>
                        <X className="size-4" aria-hidden />
                        {t("lan.actions.reject")}
                      </Button>
                    </>
                  )}
              </div>
            </CardContent>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            variant="destructive"
            disabled={disabled || !isFinishedTransfer(transfer)}
            onSelect={onRemove}
          >
            <Trash2 className="size-4" aria-hidden />
            {t("lan.actions.deleteHistory")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }
)
function isFinishedTransfer(transfer: LanTransfer): boolean {
  return (
    transfer.state === "completed" ||
    transfer.state === "rejected" ||
    transfer.state === "failed" ||
    transfer.state === "paused"
  )
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function PageFrame({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("lan.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("lan.subtitle")}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  )
}

function errorMessage(err: unknown, restartRequired: string): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("No handler registered for 'lan:") ? restartRequired : message
}

function hasSeenSecurityGuide(): boolean {
  try {
    return window.localStorage.getItem(LAN_SECURITY_GUIDE_SEEN_KEY) === "true"
  } catch {
    return false
  }
}

function markSecurityGuideSeen(): void {
  try {
    window.localStorage.setItem(LAN_SECURITY_GUIDE_SEEN_KEY, "true")
  } catch {
    // The guide can still work for this session when storage is unavailable.
  }
}
