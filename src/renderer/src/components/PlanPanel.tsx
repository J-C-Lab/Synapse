import { Check, Circle, LoaderCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export type PlanStepStatus = "pending" | "in_progress" | "completed"

export interface PlanStep {
  title: string
  status: PlanStepStatus
}

const ICON = {
  completed: Check,
  in_progress: LoaderCircle,
  pending: Circle,
} as const

export function PlanPanel({ steps, className }: { steps: PlanStep[]; className?: string }) {
  if (steps.length === 0) return null
  return (
    <ul className={cn("flex flex-col gap-1 rounded-md border p-3 text-sm", className)}>
      {steps.map((step) => {
        const Icon = ICON[step.status]
        return (
          <li
            key={`${step.title}::${step.status}`}
            data-status={step.status}
            className={cn(
              "flex items-center gap-2",
              step.status === "completed" && "text-muted-foreground line-through",
              step.status === "in_progress" && "font-medium"
            )}
          >
            <Icon
              className={cn("size-4 shrink-0", step.status === "in_progress" && "animate-spin")}
              aria-hidden
            />
            <span>{step.title}</span>
          </li>
        )
      })}
    </ul>
  )
}
