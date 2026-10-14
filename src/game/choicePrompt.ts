import { echoesTranscriptionPrompt } from './promptEcho.ts'
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

/** Расшифровка дословно повторила каталог (из двух и больше пунктов); один названный пункт — это выбор, не эхо. */
export function echoesChoicePrompt(transcript: string, prompt: string): boolean {
  if (prompt.split(/[;,]/).filter((part) => part.trim()).length < 2) return false
  return echoesTranscriptionPrompt(transcript, prompt)
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
