import type { CredentialConnectPrompt } from "@/lib/electron"
import { AlertCircle, Github, Loader2, ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export function PluginCredentialConnectDialog({
  open,
  busy,
  prompt,
  error,
  pluginId,
  onOpenChange,
}: {
  open: boolean
  busy: boolean
  prompt: CredentialConnectPrompt | null
  error: string | null
  pluginId: string
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const isGitHubInbox = pluginId === "com.synapse.github-inbox"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-hidden p-0 sm:max-w-[560px]"
        showCloseButton={false}
      >
        <div className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full flex-col">
          <div className="border-b bg-foreground px-5 py-4 text-background sm:px-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background/10">
                <Github className="size-5" aria-hidden />
              </span>
              <Badge className="border-background/20 bg-background/10 text-background hover:bg-background/10">
                GitHub
              </Badge>
            </div>
            <DialogHeader className="space-y-2 text-left">
              <DialogTitle className="text-xl leading-tight text-background">
                {t("plugins.credentials.connectDialog.title")}
              </DialogTitle>
              <DialogDescription className="max-w-[46ch] text-background/75">
                {isGitHubInbox
                  ? t("plugins.credentials.connectDialog.githubInboxDescription")
                  : t("plugins.credentials.connectDialog.description")}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6">
            {error ? (
              <Alert variant="destructive">
                <AlertCircle className="size-4" aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="rounded-lg border bg-card shadow-sm">
              <div className="flex items-start gap-4 p-5">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">
                    {prompt
                      ? t("plugins.credentials.connectDialog.browserReady")
                      : t("plugins.credentials.connectDialog.preparing")}
                  </p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {t("plugins.credentials.connectDialog.waiting")}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <ConnectStep
                index="1"
                title={t("plugins.credentials.connectDialog.stepBrowser")}
                active={Boolean(prompt) && busy}
              />
              <ConnectStep
                index="2"
                title={t("plugins.credentials.connectDialog.stepConnect")}
                active={!busy && !error}
              />
            </div>

            {isGitHubInbox ? (
              <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm leading-6 text-muted-foreground">
                {t("plugins.credentials.connectDialog.githubScopes")}
              </div>
            ) : null}

            <div className="flex items-start gap-3 rounded-md border bg-muted/30 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShieldCheck className="size-4" aria-hidden />
              </span>
              <p className="text-sm leading-6 text-muted-foreground">
                {t("plugins.credentials.connectDialog.secureHint")}
              </p>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t bg-muted/30 px-5 py-3 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("plugins.credentials.connectDialog.close")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConnectStep({ index, title, active }: { index: string; title: string; active: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground",
        active && "border-primary/40 bg-primary/5 text-foreground"
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium",
          active && "bg-primary text-primary-foreground"
        )}
      >
        {index}
      </span>
      <span className="min-w-0 truncate">{title}</span>
    </div>
  )
}
