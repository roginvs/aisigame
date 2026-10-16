import type { GameContext, PlayerId } from './types.ts'

/**
 * Чья сейчас речь в микрофоне модели: id игрока для подписи реплики в чате (имя ищет каждый экран по id).
 * null — лобби/меню/конец игры: подпись остаётся «Услышано».
 */
export function speakingPlayerId(path: string, context: GameContext): PlayerId | null {
  const top = path.split('.')[0] ?? ''
  if (!context.players.length) return null
  if (top === 'startMenu' || top === 'connecting' || top === 'restoring' || top === 'finished' || top === 'failed' || top === 'stopped') return null
  if (top === 'cat') {
    const special = context.special
    if (!special) return context.chooserId
    return path.startsWith('cat.staking') && special.recipientId !== null ? special.recipientId : special.giverId
  }
  if (top === 'auction') return context.special?.recipientId ?? context.special?.giverId ?? context.chooserId
  if (top === 'finalBets') return context.finalists[context.finalCursor] ?? null
  if (context.activePlayerId !== null) return context.activePlayerId
  return context.chooserId ?? null
}
