export type ChoiceGate = 'ignore' | 'ask-again' | 'select'

export function isChoiceUtterance(text: string, minLetters = 4): boolean {
  const letters = text.replace(/[^0-9a-zA-Zа-яА-ЯёЁ]/g, '')
  return letters.length >= minLetters
}

export function choiceGate(text: string, durationMs: number, minLetters = 4): ChoiceGate {
  if (isChoiceUtterance(text, minLetters)) return 'select'
  if (durationMs < 900) return 'ignore'
  return 'ask-again'
}

/** Речь, пока открыты кнопки: кашель и шум без фразы ничего не делают, явная фраза запоминается. */
export function blurtGate(text: string, _durationMs: number): 'ignore' | 'talk' {
  if (!isChoiceUtterance(text, 4)) return 'ignore'
  return 'talk'
}

/** Эхо чтения вопроса в микрофон — не перебивание комнаты. */
export function repeatsQuestion(heard: string, question: string): boolean {
  const said = foldSpeech(heard)
  const asked = foldSpeech(question)
  if (said.length < 8 || asked.length < 8) return false
  return asked.includes(said) || said.includes(asked)
}

function foldSpeech(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const fillerWord = /^(?:м+|мм+|хм+|э+м*|а+|о+|у+|ну|ой|ох|ах|ага|угу|ммм|эх|так|вот|ээ+)$/

const agreeWord = /^(?:ага|угу|так)$/

/**
 * Реплика из одних междометий («мм», «э-э», «ну», «ага»): это не выбор и не ответ.
 * offerOpen — ведущая предложила ячейку: «ага», «угу» тогда могут быть согласием, их решает модель.
 */
export function isFiller(text: string, offerOpen = false): boolean {
  const words = text.toLowerCase().replaceAll('ё', 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim().split(' ').filter(Boolean)
  return words.length > 0 && words.every((word) => fillerWord.test(word) && !(offerOpen && agreeWord.test(word)))
}
