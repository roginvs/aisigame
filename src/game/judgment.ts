import type { AnswerJudgment, JudgmentStatus, PlayerId } from './types.ts'

export function settleJudgment(input: {
  activeQuestionId: string
  activePlayerId: PlayerId
  attemptId: number
  questionText: string
  answers: string[]
  reportedQuestionId: string
  reportedPlayerId: number
  reportedAttemptId: number
  status: JudgmentStatus
  heard: string
  transcript: string
  confidence?: number | null
  reason: string
  source?: 'text' | 'audio'
}): AnswerJudgment {
  const heard = (input.source === 'audio' ? input.heard : input.transcript || input.heard).trim()
  const sameQuestion =
    input.reportedQuestionId === input.activeQuestionId &&
    input.reportedPlayerId === input.activePlayerId &&
    input.reportedAttemptId === input.attemptId
  let status = input.status
  let reason = input.reason
  if (!sameQuestion) {
    if (input.source === 'audio') {
      return {
        questionId: input.activeQuestionId, playerId: input.activePlayerId, attemptId: input.attemptId,
        status: 'unintelligible', heard: '', reason: 'Чужая аудиооценка отклонена.',
      }
    }
    status = heard ? (sharesAnswer(heard, input.answers) ? 'correct' : 'incorrect') : 'unintelligible'
    reason = 'Оценка ссылалась на другой вопрос. Игра сверила реплику с эталоном этой ячейки.'
  } else if (status === 'correct' && quotesForeignTitle(reason, input.questionText, [...input.answers, heard])) {
    status = 'incorrect'
    reason = 'Пояснение назвало другой вопрос. Для этой ячейки ответ не засчитывается.'
  } else if (status === 'correct' && !heard) {
    status = 'unintelligible'
    reason = 'Реплику не разобрать, верный ответ не засчитывается.'
  } else if (status === 'incorrect' && sameZeroAnswer(heard, input.answers)) {
    status = 'correct'
    reason = 'Реплика другими словами говорит то же, что эталон: ничего не осталось.'
  }
  const phonetic = phoneticKind(heard, input.answers)
  if (
    phonetic === 'near' &&
    (status === 'incorrect' || status === 'correct' || status === 'needs_clarification')
  ) {
    status = 'near_miss'
    reason = 'Реплика созвучна эталону: один звук в сторону. Нужно повторить.'
  } else if (phonetic === 'inflected' && (status === 'incorrect' || status === 'needs_clarification')) {
    status = 'near_miss'
    reason = 'Реплика созвучна эталону: один звук в сторону. Нужно повторить.'
  } else if (phonetic === 'fuzzy' && (status === 'incorrect' || status === 'needs_clarification')) {
    status = 'near_miss'
    reason = 'Реплика созвучна эталону и могла быть тем же ответом, который распознавание исказило. Нужно повторить.'
  } else if (
    (status === 'incorrect' || status === 'needs_clarification') &&
    input.source !== 'audio' &&
    typeof input.confidence === 'number' &&
    input.confidence < unsureTranscript &&
    shakyHomophone(heard, input.answers)
  ) {
    status = 'near_miss'
    reason = 'Распознавание неуверенное, а реплика похожа на эталон. Нужно повторить.'
  }
  const audioUncertain = input.source === 'audio' && (status === 'unintelligible' || status === 'ambiguous')
  if (!audioUncertain && status !== 'correct' && (sameEtalon(heard, input.answers) || syllableEtalon(heard, input.answers))) {
    status = 'correct'
    reason = 'Реплика совпала с эталоном.'
  }
  return {
    questionId: input.activeQuestionId,
    playerId: input.activePlayerId,
    attemptId: input.attemptId,
    status,
    heard,
    reason,
  }
}

export function judgmentChatText(status: JudgmentStatus, heard: string): string {
  return [`Статус: ${status}`, heard.trim() ? `Услышала: ${heard.trim()}` : 'Услышала: —'].join('\n')
}

export function sharesAnswer(heard: string, answers: string[]): boolean {
  const heardTokens = tokens(heard)
  const answerTokens = answers.flatMap(tokens)
  if (!heardTokens.length || !answerTokens.length) return false
  return heardTokens.some((left) => answerTokens.some((right) => left === right || left.startsWith(right) || right.startsWith(left)))
}

export function quotesForeignTitle(reason: string, question: string, answers: string[]): boolean {
  const allowed = normalize(`${question} ${answers.join(' ')}`)
  return titles(reason).some((title) => !allowed.includes(title))
}

/** Созвучие эталону: одно исправление или та же фраза, записанная похожим словом. */
export function nearHomophone(heard: string, answers: string[]): boolean {
  const kind = phoneticKind(heard, answers)
  return kind === 'near' || kind === 'inflected' || kind === 'fuzzy'
}

/** Вся реплика совпала с одним эталоном. Кусок длинной фразы не считается. */
export function sameEtalon(heard: string, answers: string[]): boolean {
  const said = answerKey(heard)
  if (!said) return false
  return answers.some((answer) => etalonForms(answer).some((form) => answerKey(form) === said))
}

/** «пы ле со сел» — то же слово, что «пылесосел». Другое имя, даже созвучное, сюда не входит. */
function syllableEtalon(heard: string, answers: string[]): boolean {
  const spaced = normalize(heard)
  if (!spaced.includes(' ')) return false
  const said = spaced.replace(/\s+/g, '')
  if (said.length < 4) return false
  return answers.some((answer) => etalonForms(answer).some((form) => normalize(form).replace(/\s+/g, '') === said))
}

export function sameZeroAnswer(heard: string, answers: string[]): boolean {
  const norms = answers.map(normalize).filter(Boolean)
  if (!norms.some(isNumericZeroAnswer)) return false
  const said = normalize(heard)
  if (!said || isIgnorance(said) || hasOtherQuantity(said)) return false
  const words = said.split(' ').filter(Boolean)
  const stems = answerStems(norms)
  if (!words.every((word, index) => zeroTokenAllowed(word, words[index - 1] ?? '', stems))) return false
  return hasClearZero(words) || deniesSameAbsence(words, stems)
}

function titles(value: string): string[] {
  return [...value.matchAll(/«([^»]+)»/g)]
    .map((match) => normalize(match[1] ?? ''))
    .filter((title) => title.length >= 3)
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((word) => word.length >= 4 || /^\d+$/.test(word))
}

function answerKey(value: string): string {
  return normalize(value).replace(/\s+/g, ' ')
}

/**
 * Отдельные ответы пакета уже лежат разными строками.
 * Скобки внутри одной строки — ещё одна форма целиком, без разбора по запятым и кавычкам.
 */
function etalonForms(answer: string): string[] {
  const forms = [answer]
  const groups = [...answer.matchAll(/\(([^()]*)\)/g)]
  if (!groups.length) return forms
  for (const group of groups) {
    const inner = (group[1] ?? '').trim()
    if (inner) forms.push(inner)
  }
  const outer = answer.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (outer) forms.push(outer)
  return forms
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
}

function isNumericZeroAnswer(answer: string): boolean {
  const words = answer.split(' ').filter(Boolean)
  const head = words[0] ?? ''
  if (head !== '0' && head !== 'ноль' && head !== 'нуль') return false
  return !/^\d+$/.test(words[1] ?? '')
}

function isIgnorance(said: string): boolean {
  return /\bне (знаю|понял|поняла|помню|уверен|уверена)\b/.test(said) || said.includes('без понятия')
}

function hasOtherQuantity(said: string): boolean {
  const words = said.split(' ').filter(Boolean)
  return words.some((word, index) => {
    if (/^\d+$/.test(word)) return word !== '0'
    if (word === 'одного' || word === 'одной' || word === 'одно') return words[index - 1] !== 'ни'
    return otherNumbers.has(word)
  })
}

function zeroTokenAllowed(word: string, previous: string, stems: string[]): boolean {
  if (frameWords.has(word) || zeroWords.has(word) || word === 'нет') return true
  if ((word === 'одного' || word === 'одной' || word === 'одно') && previous === 'ни') return true
  if (denialVerbs.has(word) && previous === 'не') return true
  return word.length >= 4 && stems.some((stem) => word.startsWith(stem) || stem.startsWith(word))
}

function hasClearZero(words: string[]): boolean {
  if (words.some((word) => zeroWords.has(word))) return true
  return words.some(
    (word, index) => word === 'ни' && (words[index + 1] === 'одного' || words[index + 1] === 'одной' || words[index + 1] === 'одно'),
  )
}

function deniesSameAbsence(words: string[], stems: string[]): boolean {
  const shares = words.some((word) => word.length >= 4 && stems.some((stem) => word.startsWith(stem) || stem.startsWith(word)))
  if (!shares) return false
  if (words.includes('нет')) return true
  return words.some((word, index) => word === 'не' && denialVerbs.has(words[index + 1] ?? ''))
}

function answerStems(answers: string[]): string[] {
  const stems: string[] = []
  for (const answer of answers) {
    for (const word of answer.split(' ')) {
      if (word.length < 4 || stemSkip.has(word) || /^\d+$/.test(word)) continue
      const stem = word.slice(0, 5)
      if (!stems.includes(stem)) stems.push(stem)
    }
  }
  return stems
}

const zeroWords = new Set(['0', 'ноль', 'нуль', 'нуля', 'ноля', 'нулю', 'нолю', 'нисколько', 'ничего'])

const frameWords = new Set([
  'на', 'в', 'во', 'у', 'с', 'со', 'и', 'а', 'но', 'не', 'ни', 'к', 'ко', 'по', 'из', 'от', 'до', 'за', 'о', 'об', 'обо',
  'это', 'что', 'так', 'как', 'же', 'то', 'уже', 'еще', 'всего', 'только', 'потому', 'поэтому', 'ведь', 'там', 'тут', 'вот',
  'вообще', 'просто', 'именно', 'ну', 'было', 'был', 'была', 'были', 'осталось', 'остался', 'осталась', 'остались',
])

const denialVerbs = new Set([
  'растут', 'растет', 'бывает', 'бывают', 'водятся', 'водится', 'осталось', 'остался', 'осталась', 'остались',
])

const stemSkip = new Set(['ноль', 'нуль', 'нуля', 'ноля', 'нет', 'было', 'осталось', 'остался', 'осталась', 'остались'])

const otherNumbers = new Set([
  'один', 'одна', 'два', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
  'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
  'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто',
  'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот',
  'тысяча', 'тысячи', 'тысяч',
])

type PhoneticKind = 'other' | 'exact' | 'inflected' | 'near' | 'fuzzy'

const vowels = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я'])
const fuzzyCoreRatio = 0.66
const fuzzyMaxGap = 3
const fuzzyMinLength = 5
const shellMinRatio = 0.6
const shellExtra = 2
const shakyRatio = 0.55
const shakyMinLength = 6
const shakyMaxGap = 2
const unsureTranscript = 0.4

function phoneticKind(heard: string, answers: string[]): PhoneticKind {
  const said = comparableWords(heard)
  const etalon = answers.flatMap(comparableWords)
  if (!said.length || !etalon.length) return 'other'
  let near = false
  let inflected = false
  let allRelated = true
  for (const word of said) {
    let best: PhoneticKind = 'other'
    for (const item of etalon) {
      const relation = wordRelation(word, item)
      if (relation === 'exact') {
        best = 'exact'
        break
      }
      if (relation === 'near') best = 'near'
      else if (relation === 'inflected' && best !== 'near') best = 'inflected'
    }
    if (best === 'other') {
      allRelated = false
      break
    }
    if (best === 'near') near = true
    if (best === 'inflected') inflected = true
  }
  if (allRelated) {
    if (near) return 'near'
    if (inflected) return 'inflected'
    return 'exact'
  }
  const left = said.join('')
  if (answers.some((answer) => fuzzyPhrase(left, comparableWords(answer).join('')))) return 'fuzzy'
  return 'other'
}

function fuzzyPhrase(left: string, right: string): boolean {
  if (left.length < fuzzyMinLength || right.length < fuzzyMinLength) return false
  if (Math.abs(left.length - right.length) > fuzzyMaxGap) return false
  const longest = Math.max(left.length, right.length)
  if (left.slice(0, 2) === right.slice(0, 2) && lcsLength(left, right) / longest >= fuzzyCoreRatio) return true
  return consonantShell(left, right)
}

function consonantShell(left: string, right: string): boolean {
  const a = consonants(left)
  const b = consonants(right)
  if (a.length < 4 || b.length < 4) return false
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (short.length / long.length < shellMinRatio) return false
  if (lcsLength(short, long) !== short.length) return false
  return long.length - short.length <= shellExtra
}

function consonants(word: string): string {
  return [...word].filter((letter) => !'аеиоуыэюяьъ'.includes(letter)).join('')
}

function shakyHomophone(heard: string, answers: string[]): boolean {
  const left = comparableWords(heard).join('')
  if (left.length < shakyMinLength) return false
  return answers.some((answer) => {
    const right = comparableWords(answer).join('')
    if (right.length < shakyMinLength) return false
    if (Math.abs(left.length - right.length) > shakyMaxGap) return false
    if (left.slice(0, 2) !== right.slice(0, 2)) return false
    return lcsLength(left, right) / Math.max(left.length, right.length) >= shakyRatio
  })
}

function lcsLength(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, () => 0)
  for (let i = 1; i <= left.length; i += 1) {
    const current = Array.from({ length: right.length + 1 }, () => 0)
    for (let j = 1; j <= right.length; j += 1) {
      current[j] =
        left[i - 1] === right[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

function comparableWords(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((word) => word.length >= 4 && !frameWords.has(word) && !/^\d+$/.test(word))
}

function wordRelation(left: string, right: string): PhoneticKind {
  if (left === right) return 'exact'
  const gap = Math.abs(left.length - right.length)
  if (gap > 0 && gap <= 2 && (left.startsWith(right) || right.startsWith(left))) return 'exact'
  if (finalVowelInflection(left, right)) return 'inflected'
  if (oneEditApart(left, right)) return 'near'
  return 'other'
}

function finalVowelInflection(left: string, right: string): boolean {
  if (left.length !== right.length || left.length < 4) return false
  if (left.slice(0, -1) !== right.slice(0, -1)) return false
  const leftEnd = left.at(-1) ?? ''
  const rightEnd = right.at(-1) ?? ''
  return leftEnd !== rightEnd && vowels.has(leftEnd) && vowels.has(rightEnd)
}

function oneEditApart(left: string, right: string): boolean {
  if (left === right || left.length < 4 || right.length < 4) return false
  const gap = left.length - right.length
  if (Math.abs(gap) > 1) return false
  let edits = 0
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (gap === 0) {
      i += 1
      j += 1
    } else if (gap > 0) {
      i += 1
    } else {
      j += 1
    }
  }
  if (i < left.length || j < right.length) edits += 1
  return edits === 1
}
