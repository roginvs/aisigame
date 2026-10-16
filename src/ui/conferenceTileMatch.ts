import type { ConferenceTile } from '../conference/media.ts'
import type { ConferenceJitsiPair } from '../conference/messages.ts'
import { jitsiIdOfClient } from '../conference/jitsiIds.ts'

/**
 * Плитка (камера, «говорит», микрофон) карточки игрока. Своё устройство — локальная плитка;
 * чужое — удалённая плитка с id из пар `[jitsiId, clientId]` снимка. Имя не смотрим:
 * одинаковые имена не путаются, игрок «Ведущая» — обычный игрок. Нет пары — `undefined` (пустая карточка).
 */
export function matchConferenceTile(
  tiles: readonly ConferenceTile[],
  input: { selfClientId?: string; clientId?: string | null; jitsiIds?: readonly ConferenceJitsiPair[] },
): ConferenceTile | undefined {
  if (!input.clientId) return undefined
  if (input.selfClientId && input.clientId === input.selfClientId) {
    return tiles.find((tile) => tile.isLocal)
  }
  const jitsiId = jitsiIdOfClient(input.jitsiIds, input.clientId)
  if (!jitsiId) return undefined
  return tiles.find((tile) => !tile.isLocal && tile.id === jitsiId)
}
