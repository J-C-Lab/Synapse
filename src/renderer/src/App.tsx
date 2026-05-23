import { useTranslation } from "react-i18next"
import { ElectronDemo } from "@/components/electron-demo"
import { TooltipProvider } from "@/components/ui/tooltip"

export function App() {
  const { t } = useTranslation()

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col items-center justify-center bg-background text-foreground font-sans">
        <main className="flex w-full max-w-3xl flex-col items-center gap-8 px-8 py-16 sm:items-start">
          <h1 className="text-3xl font-semibold tracking-tight">{t("app.title")}</h1>
          <p className="max-w-md text-base text-muted-foreground">{t("app.subtitle")}</p>
          <ElectronDemo />
        </main>
      </div>
    </TooltipProvider>
  )
}
