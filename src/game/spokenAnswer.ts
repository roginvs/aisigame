import { spokenChoiceForms } from './choices.ts'
import type { QuestionChoice } from './types.ts'

/** Явное разрешение: без него общий запрет «не раскрывай ответ» перевешивает, и модель отказывается. */
export const revealAuthorization = 'В этом ходе игра уже приняла решение и просит назвать эталон вслух.'

/**
 * Что произнести из эталона пакета. Ответ — фиксированный текст (первая форма пакета,
 * буква варианта вместе с текстом: «D. Звёздные войны»); остальное ведущая формулирует сама.
 */
export function spokenAnswerCue(answers: readonly string[], choices: readonly QuestionChoice[] = []): string {
  const list = spokenChoiceForms(answers, choices)
  if (list.length === 0) return 'Правильного ответа в пакете нет. Свой ответ не придумывай.'
  return `${revealAuthorization} Начни с правильного ответа дословно: «${list[0]}». Другие формы ответа не перечисляй и свой ответ не придумывай. Затем одна короткая связка к следующему ходу.`
}
