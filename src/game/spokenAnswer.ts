import { spokenChoiceForms } from './choices.ts'
import type { QuestionChoice } from './types.ts'

/** Явное разрешение: без него общий запрет «не раскрывай ответ» перевешивает, и модель отказывается. */
export const revealAuthorization = 'В этом ходе игра уже приняла решение и просит назвать эталон вслух.'

/**
 * Что произнести из эталона пакета. Ответ — фиксированный текст (первая форма пакета,
 * буква варианта вместе с текстом: «D. Звёздные войны»); остальное ведущая формулирует сама.
 */
export function spokenAnswerCue(answers: readonly string[], choices: readonly QuestionChoice[] = [], opener = ''): string {
  const list = spokenChoiceForms(answers, choices)
  const first = list[0]
  if (first === undefined) return `${opener ? `${opener} ` : ''}Правильного ответа в пакете нет. Свой ответ не придумывай.`
  const tail = 'Другие формы ответа не перечисляй и свой ответ не придумывай. Затем одна короткая связка к следующему ходу.'
  // Одно правило начала реплики: либо сразу эталон, либо заданное начало и сразу за ним эталон.
  if (opener) return `${revealAuthorization} ${opener} Сразу за этим — правильный ответ дословно: «${first}»; слова «правильный ответ» перед ним можно не говорить. ${tail}`
  return `${revealAuthorization} Начни с правильного ответа дословно: «${first}». ${tail}`
}
