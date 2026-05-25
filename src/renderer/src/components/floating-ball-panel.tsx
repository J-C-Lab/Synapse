import type { PointerEvent } from "react"
import { Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import logoUrl from "@/assets/logo.svg"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  getSettings,
  moveFloatingBallBy,
  onFloatingBallFeatures,
  onFloatingBallMenuState,
  openFloatingBallFeature,
  toggleFloatingBallMenu,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

const FEATURE_ICONS: Record<DeskitFloatingBallFeature, typeof Search> = {
  appLauncher: Search,
}
const MENU_SLOT_ANGLES = [30, 90, 150, 210, 270, 330] as const
const DRAG_THRESHOLD = 4

export function FloatingBallPanel() {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [features, setFeatures] = useState<DeskitFloatingBallFeature[]>(["appLauncher"])
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
  } | null>(null)
  const suppressNextClickRef = useRef(false)

  useEffect(() => {
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

  useEffect(() => {
    void getSettings().then((settings) => setFeatures(settings.floatingBallFeatures))
    return mergeCleanups(onFloatingBallMenuState(setExpanded), onFloatingBallFeatures(setFeatures))
  }, [])

  const menuItems = useMemo(() => features.slice(0, 6), [features])

  async function onFeatureClick(feature: DeskitFloatingBallFeature) {
    await openFloatingBallFeature(feature)
    setExpanded(false)
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moved: false,
    }
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = {
      x: event.screenX - drag.lastX,
      y: event.screenY - drag.lastY,
    }
    if (delta.x === 0 && delta.y === 0) return
    drag.moved =
      drag.moved ||
      Math.abs(event.screenX - drag.startX) >= DRAG_THRESHOLD ||
      Math.abs(event.screenY - drag.startY) >= DRAG_THRESHOLD
    drag.lastX = event.screenX
    drag.lastY = event.screenY
    void moveFloatingBallBy(delta)
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    suppressNextClickRef.current = drag.moved
    dragRef.current = null
  }

  function onBallClick() {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    void toggleFloatingBallMenu()
  }

  return (
    <div
      className="relative h-screen w-screen select-none overflow-hidden bg-transparent"
      onDragStart={(event) => event.preventDefault()}
    >
      <div
        className={cn(
          "absolute left-1/2 top-1/2 size-[220px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 dark:border-white/20 bg-background/90 shadow-2xl shadow-black/20 backdrop-blur-xl transition-[opacity,transform] duration-150",
          expanded ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        aria-hidden={!expanded}
      >
        {menuItems.map((feature, index) => {
          const Icon = FEATURE_ICONS[feature]
          const angle = MENU_SLOT_ANGLES[index] ?? 30
          const radius = 78
          const x = Math.cos((angle * Math.PI) / 180) * radius
          const y = -Math.sin((angle * Math.PI) / 180) * radius
          return (
            <Tooltip key={feature}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void onFeatureClick(feature)}
                  className="absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-popover text-popover-foreground shadow-lg transition hover:scale-110 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
                >
                  <Icon className="size-5" aria-hidden />
                  <span className="sr-only">{t(`floatingBall.features.${feature}`)}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t(`floatingBall.features.${feature}`)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onBallClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title={t("floatingBall.title")}
        className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 cursor-move place-items-center rounded-full border border-border bg-white dark:bg-popover shadow-xl transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img src={logoUrl} alt="" draggable={false} className="size-8" aria-hidden />
        <span className="sr-only">{t("floatingBall.title")}</span>
      </button>
    </div>
  )
}

function mergeCleanups(...cleanups: Array<() => void>): () => void {
  return () => cleanups.forEach((cleanup) => cleanup())
}
