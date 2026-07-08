import { Check, ChevronDown } from "lucide-react"
import { useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export type PlanStepStatus = "pending" | "in_progress" | "completed"

export interface PlanStep {
  title: string
  status: PlanStepStatus
}

export function PlanPanel({ steps, className }: { steps: PlanStep[]; className?: string }) {
  const [open, setOpen] = useState(true)
  if (steps.length === 0) return null
  const completedCount = steps.filter((step) => step.status === "completed").length

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("w-72 rounded-lg border bg-card text-card-foreground shadow-sm", className)}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-semibold hover:bg-accent/40">
        <span>Progress</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          {completedCount}/{steps.length}
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {steps.map((step, index) => (
            <li
              key={`${step.title}::${index}`}
              data-status={step.status}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-1 py-1 text-sm",
                step.status === "in_progress" && "bg-accent/60"
              )}
            >
              <PlanStepBadge status={step.status} index={index} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  step.status === "completed" && "text-muted-foreground line-through",
                  step.status === "in_progress" && "font-medium text-foreground",
                  step.status === "pending" && "text-muted-foreground"
                )}
              >
                {step.title}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function PlanStepBadge({ status, index }: { status: PlanStepStatus; index: number }) {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3" aria-hidden />
      </span>
    )
  }
  if (status === "in_progress") {
    return (
      <span
        className="flex size-5 shrink-0 animate-pulse items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
        aria-hidden
      >
        {index + 1}
      </span>
    )
  }
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] font-medium text-muted-foreground"
      aria-hidden
    >
      {index + 1}
    </span>
  )
}
