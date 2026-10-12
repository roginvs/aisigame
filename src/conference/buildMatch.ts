import { buildCommit } from '../buildInfo.ts'

/** Сообщение joiner при чужом commit мастера; `null`, если совпало. */
export function masterBuildMismatchMessage(masterCommit: string | undefined): string | null {
  const mine = buildCommit()
  const theirs = typeof masterCommit === 'string' ? masterCommit.trim() : ''
  if (theirs === mine) return null
  return `Версия не совпадает с мастером: у вас ${mine}, у мастера ${theirs || 'неизвестна'}. Обновите страницу и зайдите снова.`
}
