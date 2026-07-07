export function checkAsrCeiling(
  asr: Record<string, number>,
  ceilings: Record<string, number>
): { ok: boolean; regressions: string[] } {
  const regressions = Object.entries(asr)
    .filter(([surface, rate]) => rate > (ceilings[surface] ?? 0))
    .map(([surface]) => surface)
  return { ok: regressions.length === 0, regressions }
}
