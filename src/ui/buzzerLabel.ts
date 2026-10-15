/** Подпись кнопки во время фальстарта: держится, пока кнопка снова не станет доступна. */
export const falseStartLabel = 'Фальстарт'

/**
 * Подпись кнопки игрока из полученного состояния. Пока идёт штраф фальстарта (`cooling`,
 * из `falseStarts` + `penaltyClock`, в паузе часы стоят), вместо обычной подписи — «Фальстарт».
 * Подпись апелляции важнее: это отдельная кнопка-действие.
 */
export function buzzerLabel(options: { appealLabel?: string; cooling: boolean; normal: string }): string {
  if (options.appealLabel) return options.appealLabel
  return options.cooling ? falseStartLabel : options.normal
}
