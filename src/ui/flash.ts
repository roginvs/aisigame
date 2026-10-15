/**
 * Вспышка полоски таймера: ключ = личность окна (фаза + вопрос + попытка).
 * Countdown перемонтируется по этому ключу, и CSS-анимация `timer-flash` проигрывается
 * один раз на новое окно, но не на перерисовки и не на снимки-пульсы (ключ тот же).
 * Рамка игрока вспыхивает чистым CSS: анимация на `.player.active` стартует, когда класс
 * появляется (фокус перешёл к игроку), и не перезапускается, пока класс держится.
 */
export function timerFlashKey(path: string, questionId: string | null | undefined, attemptId: number): string {
  return `${path}|${questionId ?? '-'}|${attemptId}`
}
