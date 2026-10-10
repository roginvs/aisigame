import type { Question, QuestionPack, RoundInfo, RoundKind } from './types.ts'

export function norm(value: string): string {
  return value.trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ')
}

export function questionsInRound(questions: Question[], roundIndex: number): Question[] {
  return questions.filter((question) => question.roundIndex === roundIndex)
}

export function questionById(questions: Question[], id: string | null): Question | undefined {
  if (!id) return undefined
  return questions.find((question) => question.id === id)
}

export function findQuestion(
  questions: Question[],
  roundIndex: number,
  theme: string,
  value: number,
  kind: RoundKind,
): Question | undefined {
  const needle = norm(theme)
  const inRound = questionsInRound(questions, roundIndex)
  const themed = inRound.filter((question) => themeMatches(question, needle))
  if (kind === 'final') return themed[0]
  return themed.find((question) => question.value === value)
}

function themeMatches(question: Question, needle: string): boolean {
  if (!needle) return false
  const id = norm(question.themeId)
  const name = norm(question.themeName)
  if (id === needle || name === needle) return true
  return needle.length >= 3 && (name.includes(needle) || needle.includes(name))
}

export function roundThemes(questions: Question[], roundIndex: number): { id: string; name: string }[] {
  const seen = new Set<string>()
  const list: { id: string; name: string }[] = []
  for (const question of questionsInRound(questions, roundIndex)) {
    if (seen.has(question.themeId)) continue
    seen.add(question.themeId)
    list.push({ id: question.themeId, name: question.themeName })
  }
  return list
}

export function roundPrices(questions: Question[], roundIndex: number): number[] {
  return [...new Set(questionsInRound(questions, roundIndex).map((question) => question.value))].sort(
    (left, right) => left - right,
  )
}

export function currentRound(pack: Pick<QuestionPack, 'rounds'>, roundIndex: number): RoundInfo | undefined {
  return pack.rounds.find((round) => round.index === roundIndex)
}

export function nextPlayableRound(rounds: RoundInfo[], questions: Question[], roundIndex: number): number {
  for (const round of rounds) {
    if (round.index <= roundIndex) continue
    if (questions.some((question) => question.roundIndex === round.index)) return round.index
  }
  return -1
}

export function roundCleared(questions: Question[], roundIndex: number, playedIds: string[]): boolean {
  const round = questionsInRound(questions, roundIndex)
  return round.length > 0 && round.every((question) => playedIds.includes(question.id))
}
