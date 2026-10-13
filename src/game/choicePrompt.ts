const hundreds: Record<number, string> = {
  0: 'ноль',
  100: 'сто',
  200: 'двести',
  300: 'триста',
  400: 'четыреста',
  500: 'пятьсот',
  600: 'шестьсот',
  700: 'семьсот',
  800: 'восемьсот',
  900: 'девятьсот',
}

export function priceWords(value: number): string {
  if (value in hundreds) return hundreds[value] ?? String(value)
  if (value === 1000) return 'тысяча'
  if (value > 1000 && value < 2000 && value % 100 === 0) {
    const rest = hundreds[value - 1000]
    return rest ? `тысяча ${rest}` : String(value)
  }
  return String(value)
}

const transcriptionPromptMax = 1024
const severalNames = 3
const manyPrices = 3

export function choicePrompt(kind: 'normal' | 'final', cells: { theme: string; value: number }[]): string {
  if (!cells.length) return 'Игрок выбирает ячейку на табло.'
  if (kind === 'final') {
    const themes = [...new Set(cells.map((cell) => cell.theme))]
    return wrapCatalog(themes.join('; '))
  }
  const withWords = themePrices(cells, true)
  if (withWords.length + 2 <= transcriptionPromptMax) return `{${withWords}}`
  return wrapCatalog(themePrices(cells, false))
}

/** Расшифровка повторяет подсказку тем, а не реплику игрока. */
export function echoesChoicePrompt(transcript: string, prompt: string): boolean {
  if (/^\s*тема и цена(?=$|[^\p{L}\p{N}])/iu.test(transcript)) return true
  const said = canon(transcript)
  const hint = canon(prompt)
  if (!said || !hint) return false
  const clauses = catalogClauses(prompt)
  const themes = [...new Set(clauses.map(themeOf).filter((theme) => theme.length >= 2))]
  if (themes.filter((theme) => themeNeedles(theme).some((needle) => mentions(transcript, needle))).length >= severalNames) {
    return true
  }
  const saidPrices = priceCount(transcript)
  const hintPrices = priceCount(prompt)
  if (said === hint && (themes.length >= severalNames || hintPrices >= manyPrices || clauses.length >= severalNames)) {
    return true
  }
  if (hint.includes(said) && saidPrices >= manyPrices && said.length >= 24) return true
  if (said.includes(hint) && hintPrices >= manyPrices && hint.length >= 24) return true
  return false
}

function themePrices(cells: { theme: string; value: number }[], words: boolean): string {
  const grouped = new Map<string, number[]>()
  for (const cell of cells) {
    const values = grouped.get(cell.theme) ?? []
    if (!values.includes(cell.value)) values.push(cell.value)
    grouped.set(cell.theme, values)
  }
  return [...grouped.entries()]
    .map(([theme, values]) => `${theme} ${values.map((value) => priceHint(value, words)).join(', ')}`)
    .join('; ')
}

function priceHint(value: number, words: boolean): string {
  const digits = String(value)
  if (!words) return digits
  const spoken = priceWords(value)
  return spoken === digits ? digits : `${digits} ${spoken}`
}

export function wrapCatalog(body: string): string {
  const room = transcriptionPromptMax - 2
  let slice = body
  if (slice.length > room) {
    slice = slice.slice(0, room)
    const breakAt = Math.max(slice.lastIndexOf('; '), slice.lastIndexOf(', '))
    if (breakAt > 16) slice = slice.slice(0, breakAt)
    slice = slice.replace(/[,;\s]+$/, '')
  }
  const wrapped = `{${slice}}`
  return wrapped.length <= transcriptionPromptMax ? wrapped : wrapped.slice(0, transcriptionPromptMax)
}

function catalogClauses(prompt: string): string[] {
  const stripped = fold(prompt)
    .replace(/[{}]/g, '')
    .replace(/^\s*тема и цена\s*:?\s*/, '')
    .replace(/^\s*тема финала\s*:?\s*/, '')
    .replace(/\.+\s*$/, '')
  return stripped
    .split(';')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

function themeOf(clause: string): string {
  const priced = clause.match(/^(.*?)\s+\d{2,5}(?!\d)/)
  return (priced?.[1] ?? clause).trim()
}

function themeNeedles(theme: string): string[] {
  const folded = fold(theme)
  const words = folded.replace(/\p{Extended_Pictographic}/gu, ' ').replace(/\s+/g, ' ').trim()
  if (words.length >= 2 && words !== folded) return [folded, words]
  return [folded]
}

function canon(text: string): string {
  return fold(text)
    .replace(/[{}]/g, ' ')
    .replace(/^\s*тема и цена\s*:?\s*/, '')
    .replace(/^\s*тема финала\s*:?\s*/, '')
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

function mentions(haystack: string, phrase: string): boolean {
  const needle = fold(phrase)
  if (needle.length < 2) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(fold(haystack))
}

function priceCount(text: string): number {
  return fold(text).match(/(?<![\p{L}\p{N}])\d{2,5}(?![\p{L}\p{N}])/gu)?.length ?? 0
}

/** Подсказка распознаванию при выборе получателя кота: имена кандидатов, тот же формат и предел длины, что у каталога ячеек. */
export function playersPrompt(names: string[]): string {
  if (!names.length) return 'Игрок называет другого игрока.'
  return wrapCatalog(names.join('; '))
}

/** Подсказка для ставки: варианты экрана суммами со словами («300 триста»), «пас», «ва-банк». */
export function optionsPrompt(options: Array<{ kind: 'pass' } | { kind: 'stake' | 'allIn' | 'min' | 'max'; amount: number }>): string {
  if (!options.length) return 'Игрок называет ставку.'
  return wrapCatalog(options.map((option) => {
    if (option.kind === 'pass') return 'пас'
    const amount = priceHint(option.amount, true)
    if (option.kind === 'allIn') return `ва-банк ${amount}`
    if (option.kind === 'min') return `минимум ${amount}`
    if (option.kind === 'max') return `максимум ${amount}`
    return amount
  }).join('; '))
}
