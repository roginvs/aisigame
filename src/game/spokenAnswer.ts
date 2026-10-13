import { spokenChoiceForms } from './choices.ts'
import type { QuestionChoice } from './types.ts'

/**
 * Что произнести из эталона пакета.
 * Один ответ — как есть. Несколько — ровно один самый естественный вариант, остальные не перечисляются.
 * Буква варианта произносится вместе с его текстом: «D. Звёздные войны».
 */
export function spokenAnswerCue(answers: readonly string[], choices: readonly QuestionChoice[] = []): string {
  const list = spokenChoiceForms(answers, choices)
  if (list.length === 0) return 'Правильного ответа в пакете нет. Свой ответ не придумывай.'
  if (list.length === 1) {
    return `Сначала произнеси правильный ответ: «${list[0]}». Другой ответ не придумывай. Затем одна короткая связка к следующему ходу.`
  }
  const quoted = list.map((item) => `«${item}»`).join(', ')
  return `Сначала произнеси один самый очевидный ответ из списка: ${quoted}. Назови ровно один вариант, остальные не перечисляй. Ответ, которого нет в списке, не придумывай. Затем одна короткая связка к следующему ходу.`
}
