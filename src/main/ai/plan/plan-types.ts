export type PlanStepStatus = "pending" | "in_progress" | "completed"

export interface PlanStep {
  title: string
  status: PlanStepStatus
}
