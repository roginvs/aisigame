import type { AnnounceKind, QuestionMedia } from './types.ts'

/** Правильный ответ виден и произносится, только когда ячейка закрыта без верного ответа. */
export function answerIsPublic(kind: AnnounceKind | null, cellClosed: boolean): boolean {
  if (!cellClosed) return false
  return kind === 'nobody' || kind === 'incorrect' || kind === 'silence' || kind === 'unclear'
}

/** Звук или ролик ответа на табло после публичного эталона — их нужно доиграть. */
export function publicAnswerHasPlayable(input: {
  kind: AnnounceKind | null
  cellClosed: boolean
  answerMedia?: readonly QuestionMedia[]
}): boolean {
  if (!answerIsPublic(input.kind, input.cellClosed)) return false
  return (input.answerMedia ?? []).some(
    (item) => (item.kind === 'audio' || item.kind === 'video') && Boolean(item.url),
  )
}

export type StageMedia = {
  /** Звук вопроса и, если показ ответа без картинки и ролика, вся картинка и ролик вопроса. */
  question: QuestionMedia[]
  /** Картинка и ролик ответа: они занимают место картинки и ролика вопроса. */
  answerVisual: QuestionMedia[]
  /** То, что стоит на месте картинки вопроса: ролик или картинка ответа, затем оставшийся звук вопроса. */
  slot: QuestionMedia[]
  /** Звук ответа. Картинку вопроса он не заменяет. */
  answerAudio: QuestionMedia[]
}

function isVisual(item: QuestionMedia): boolean {
  return item.kind === 'image' || item.kind === 'video'
}

/** Пока ответ не публичный, медиа ответа нет на табло. Картинка или ролик ответа сменяют картинку и ролик вопроса, а не встают под ними. */
export function stageMedia(
  questionMedia: readonly QuestionMedia[],
  answerMedia: readonly QuestionMedia[],
  showAnswer: boolean,
): StageMedia {
  if (!showAnswer) {
    const question = [...questionMedia]
    return { question, answerVisual: [], slot: question, answerAudio: [] }
  }
  const answerVisual = answerMedia.filter(isVisual)
  const answerAudio = answerMedia.filter((item) => item.kind === 'audio')
  const question = answerVisual.length ? questionMedia.filter((item) => item.kind === 'audio') : [...questionMedia]
  return { question, answerVisual, slot: [...answerVisual, ...question], answerAudio }
}

/**
 * Подпись под репликой ведущей в «Разговоре».
 * На табло после верного ответа её нет, и в речь она не входит.
 */
export function chatAnswerNote(input: {
  kind: AnnounceKind | null
  cellClosed: boolean
  answers: string[]
  spoken: string
}): string {
  const answers = input.answers.map((item) => item.trim()).filter(Boolean)
  if (!input.cellClosed || answers.length === 0) return ''
  const closedCorrect = input.kind === 'correct'
  const missingFromSpeech = answerIsPublic(input.kind, true) && !spokenContainsAnswers(input.spoken, answers)
  if (!closedCorrect && !missingFromSpeech) return ''
  return `Правильный ответ: ${answers.join(', ')}`
}

function spokenContainsAnswers(spoken: string, answers: string[]): boolean {
  const said = ` ${fold(spoken)} `
  return answers.every((answer) => said.includes(` ${fold(answer)} `))
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
