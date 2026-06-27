"use client"

import { GripVerticalIcon } from "lucide-react"
import * as React from "react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.PanelGroupProps) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  )
}

const ResizablePanel = React.forwardRef<
  ResizablePrimitive.ImperativePanelHandle,
  ResizablePrimitive.PanelProps
>(({ ...props }, ref) => (
  <ResizablePrimitive.Panel ref={ref} data-slot="resizable-panel" {...props} />
))
ResizablePanel.displayName = "ResizablePanel"

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.PanelResizeHandleProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        "group relative flex w-px items-center justify-center bg-border/80 transition-colors hover:bg-primary/35 data-[resize-handle-state=drag]:bg-primary/50 data-[resize-handle-state=hover]:bg-primary/35 after:absolute after:inset-y-0 after:left-1/2 after:w-1.5 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1.5 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-8 w-3.5 items-center justify-center rounded-sm border border-border/80 bg-background text-muted-foreground shadow-sm backdrop-blur-sm transition-colors group-hover:border-primary/25 group-hover:bg-primary/5 group-hover:text-primary group-data-[resize-handle-state=drag]:border-primary/40 group-data-[resize-handle-state=drag]:bg-primary/10 group-data-[resize-handle-state=drag]:text-primary">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
