import type { Question, QuestionChoice } from './types.ts'

/** Фраза, которую ведущая читает: текст ячейки и каждый вариант. */
export function questionSpeech(question: Pick<Question, 'text' | 'choices'>): string {
  const choices = question.choices ?? []
  if (!choices.length) return question.text
  return [question.text, ...choices.map(choiceLine)].filter(Boolean).join('\n')
}

export function choiceLine(choice: Pick<QuestionChoice, 'label' | 'text'>): string {
  return choice.text ? `${choice.label}. ${choice.text}` : `${choice.label}.`
}

/** Буква из right и текст того же варианта — оба эталона. */
export function withChoiceTexts(answers: string[], choices: readonly QuestionChoice[]): string[] {
  const seen = new Set(answers.map((item) => item.trim().toLowerCase()))
  const extra: string[] = []
  for (const answer of answers) {
    const choice = choiceByLabel(answer, choices)
    const text = choice?.text.trim() ?? ''
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    extra.push(text)
  }
  return [...answers, ...extra]
}

/** Как произнести эталон: «D. Звёздные войны», без второго дубля текста. */
export function spokenChoiceForms(answers: readonly string[], choices: readonly QuestionChoice[]): string[] {
  const folded = new Set<string>()
  const forms: string[] = []
  for (const answer of answers) {
    const trimmed = answer.trim()
    if (!trimmed) continue
    const choice = choiceByLabel(trimmed, choices)
    if (choice?.text) {
      forms.push(choiceLine(choice))
      folded.add(choice.text.trim().toLowerCase())
      continue
    }
    if (folded.has(trimmed.toLowerCase())) continue
    forms.push(trimmed)
  }
  return forms
}

export function choiceIsAnswer(choice: Pick<QuestionChoice, 'label' | 'text'>, answers: readonly string[]): boolean {
  return answers.some((answer) => {
    const key = answer.trim().toLowerCase().replace(/\.$/, '')
    if (!key) return false
    if (key === choice.label.trim().toLowerCase()) return true
    return Boolean(choice.text) && key === choice.text.trim().toLowerCase()
  })
}

function choiceByLabel(answer: string, choices: readonly QuestionChoice[]): QuestionChoice | undefined {
  const key = answer.trim().toLowerCase().replace(/\.$/, '')
  if (!key) return undefined
  return choices.find((choice) => choice.label.trim().toLowerCase() === key)
}
