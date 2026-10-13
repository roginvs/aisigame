import type { GameContext } from '../game/types.ts'

/** Узлы, где табло показывает панель кота/аукциона вместо вопроса. */
export function specialPanelPath(path: string, context: GameContext): boolean {
  if (!context.special) return false
  return path.startsWith('cat.') || path.startsWith('auction.') || path === 'specialAway'
}
