import type { ChatRole } from '../debug/trace.ts'

/** Подпись реплики: у игрока — его имя (без глагола), в лобби — «Услышано». */
export function roleLabel(role: ChatRole, speaker?: string): string {
  if (role === 'player') return speaker?.trim() || 'Услышано'
  if (role === 'judge') return 'Оценка'
  if (role === 'error') return 'Ошибка'
  if (role === 'system') return 'Игра'
  return 'Ведущая'
}

/** Имя говорившего по id из players снимка (у мастера и гостя — своего полученного). Не нашли — ''. */
export function speakerName(players: readonly { id: number; name: string }[] | undefined, id: number | undefined): string {
  if (id === undefined || !players) return ''
  return players.find((player) => player.id === id)?.name ?? ''
}
