import type { GameContext } from '../game/types.ts'

/** Финал: панели скрытого ввода. Ставки — в `finalBets.collecting`, ответы — в `finalTyped`; в паузе то же по `resumePath`. */
export function finalEntryPath(path: string, context: GameContext): boolean {
  if (path === 'finalBets.collecting' || path === 'finalTyped') return true
  if (path === 'paused') return context.resumePath === 'finalBets.collecting' || context.resumePath === 'finalTyped'
  return false
}

/** Финал: бейдж разбора — что открыт последний вопрос. */
export function finalRevealPath(path: string): boolean {
  return path === 'finalReveal.look' || path === 'finalReveal.verdict' || path === 'finalReveal.stakeCue' ||
    path === 'finalReveal.scoreCue'
}
