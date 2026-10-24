export type KeyboardPlayerId = 1 | 2 | 3

export function isKeyboardPlayer(id: number): id is KeyboardPlayerId {
  return id === 1 || id === 2 || id === 3
}

export const buzzKeyLabel: Record<KeyboardPlayerId, string> = {
  1: 'левый Ctrl',
  2: 'пробел',
  3: 'правый Ctrl',
}

/** Подпись клавиши местного места. С четвёртого места клавиши нет — только кнопка на экране. */
export function localSeatKeyLabel(index: number, count: number): string | null {
  if (index < 0 || count < 1 || index > 2) return null
  if (count === 1) return index === 0 ? buzzKeyLabel[2] : null
  if (count === 2) {
    if (index === 0) return buzzKeyLabel[1]
    if (index === 1) return buzzKeyLabel[3]
    return null
  }
  if (index === 0) return buzzKeyLabel[1]
  if (index === 1) return buzzKeyLabel[2]
  if (index === 2) return buzzKeyLabel[3]
  return null
}

/** Клавиша → id игрока среди местных мест, не глобальный номер. */
export function playerIdFromLocalBuzzKey(
  code: string,
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean },
  localPlayerIds: readonly number[],
): number | null {
  if (modifiers.alt || modifiers.meta || modifiers.shift) return null
  const count = localPlayerIds.length
  let index: number | null = null
  if (count === 1) {
    if (code === 'Space' && !modifiers.ctrl) index = 0
  } else if (count === 2) {
    if (code === 'ControlLeft') index = 0
    else if (code === 'ControlRight') index = 1
  } else if (count >= 3) {
    if (code === 'ControlLeft') index = 0
    else if (code === 'Space' && !modifiers.ctrl) index = 1
    else if (code === 'ControlRight') index = 2
  }
  if (index === null) return null
  return localPlayerIds[index] ?? null
}

export function playerFromBuzzKey(
  code: string,
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean },
): KeyboardPlayerId | null {
  if (modifiers.alt || modifiers.meta || modifiers.shift) return null
  if (code === 'ControlLeft') return 1
  if (code === 'ControlRight') return 3
  if (code === 'Space' && !modifiers.ctrl) return 2
  return null
}
