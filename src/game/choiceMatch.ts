export type ChoiceCell = {
  themeId: string
  themeName: string
  value: number
}

const hundredWords: Record<string, number> = {
  сто: 100,
  сотка: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
}

/** Одна открытая ячейка, если в реплике ровно одна тема и одна цена. Иначе null. */
export function matchSpokenCell(
  transcript: string,
  cells: ChoiceCell[],
  kind: 'normal' | 'final',
): ChoiceCell | null {
  const spoken = words(transcript)
  if (!spoken || !cells.length) return null
  const themes = uniqueThemes(cells)
  const mentioned = themesMentioned(spoken, themes)
  if (mentioned.length !== 1) return null
  const theme = mentioned[0]
  if (!theme) return null
  const themed = cells.filter((cell) => cell.themeId === theme.themeId)
  if (kind === 'final') return themed[0] ?? null
  const prices = spokenPrices(spoken)
  if (prices.length !== 1) return null
  const hits = themed.filter((cell) => cell.value === prices[0])
  return hits.length === 1 ? (hits[0] ?? null) : null
}

export function selectionChatText(transcript: string, accepted: boolean, cell: string): string {
  return [
    `Выбор: ${accepted ? 'уверена' : 'не уверена'}`,
    `Услышала: ${transcript.trim() || '—'}`,
    `Ячейка: ${cell.trim() || '—'}`,
  ].join('\n')
}

function uniqueThemes(cells: ChoiceCell[]): ChoiceCell[] {
  const seen = new Set<string>()
  const themes: ChoiceCell[] = []
  for (const cell of cells) {
    if (seen.has(cell.themeId)) continue
    seen.add(cell.themeId)
    themes.push(cell)
  }
  return themes
}

function themesMentioned(spoken: string, themes: ChoiceCell[]): ChoiceCell[] {
  const hits = new Map<string, ChoiceCell>()
  const dotted = themes.flatMap((theme) => {
    const mask = letterMask(theme.themeName)
    return mask ? [{ theme, mask }] : []
  })
  for (const theme of themes) {
    if (hasPhrase(spoken, theme.themeName)) hits.set(theme.themeId, theme)
  }
  for (const token of spoken.split(' ')) {
    if (token.length < 2 || /^\d+$/.test(token) || hundredWords[token] || token === 'тысяча') continue
    const fitted = dotted.filter((item) => wordFitsMask(token, item.mask))
    if (fitted.length !== 1) continue
    const theme = fitted[0]?.theme
    if (theme) hits.set(theme.themeId, theme)
  }
  return [...hits.values()]
}

function letterMask(theme: string): { head: string; tail: string } | null {
  const compact = theme.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}.…]/gu, '')
  const match = compact.match(/^(\p{L}+)(?:\.{2,}|…)(\p{L}+)$/u)
  if (!match?.[1] || !match[2]) return null
  return { head: match[1], tail: match[2] }
}

function wordFitsMask(word: string, mask: { head: string; tail: string }): boolean {
  const glued = mask.head + mask.tail
  if (word === glued) return true
  return word.length > glued.length && word.startsWith(mask.head) && word.endsWith(mask.tail)
}

function spokenPrices(spoken: string): number[] {
  const tokens = spoken.split(' ')
  const found = new Set<number>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (/^\d{2,5}$/.test(token)) {
      found.add(Number(token))
      continue
    }
    if (token === 'тысяча') {
      const next = tokens[index + 1]
      const rest = next ? hundredWords[next] : undefined
      if (rest && next !== 'сотка') {
        found.add(1000 + rest)
        index += 1
        continue
      }
      found.add(1000)
      continue
    }
    const value = hundredWords[token]
    if (value) found.add(value)
  }
  return [...found]
}

function hasPhrase(spoken: string, phrase: string): boolean {
  const needle = words(phrase)
  if (needle.length < 2) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u').test(spoken)
}

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
