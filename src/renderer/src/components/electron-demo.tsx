import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { greet, isElectron } from "@/lib/electron"

export function ElectronDemo() {
  const { t } = useTranslation()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!isElectron()) return null

  async function handleClick() {
    setError(null)
    try {
      setMessage(await greet("World"))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <Button onClick={handleClick}>{t("demo.callGreet")}</Button>
      {message && <p className="text-sm">{message}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  )
}
