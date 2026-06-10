import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function PermissionTagList({
  className,
  emptyLabel,
  permissions,
}: {
  className?: string
  emptyLabel?: string
  permissions?: string[]
}) {
  const { t } = useTranslation()
  const items = uniquePermissions(permissions)

  if (items.length === 0) {
    return emptyLabel ? (
      <div className={cn("flex flex-wrap gap-2", className)}>
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {emptyLabel}
        </Badge>
      </div>
    ) : null
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {items.map((permission) => (
        <Badge key={permission} variant="secondary" className="font-normal" title={permission}>
          {t(`permissions.items.${permission}`, { defaultValue: permission, nsSeparator: false })}
        </Badge>
      ))}
    </div>
  )
}

function uniquePermissions(permissions?: string[]): string[] {
  return [...new Set(permissions ?? [])].sort((left, right) => left.localeCompare(right))
}
