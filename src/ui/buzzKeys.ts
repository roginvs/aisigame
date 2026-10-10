export type KeyboardPlayerId = 1 | 2 | 3

export function isKeyboardPlayer(id: number): id is KeyboardPlayerId {
  return id === 1 || id === 2 || id === 3
}

export const buzzKeyLabel: Record<KeyboardPlayerId, string> = {
  1: 'левый Ctrl',
  2: 'пробел',
  3: 'правый Ctrl',
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
