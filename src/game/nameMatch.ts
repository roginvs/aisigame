/** Имя получателя кота голосом: «Матвею», «Маше», «Игроку 2», «второму» (docs/CAT.md). */
import type { PlayerId } from './types.ts'

const endings = ['ой', 'ей', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'у', 'ю', 'е', 'и', 'ы', 'а', 'я', 'ь', 'й', 'о']
const ordinals: Record<string, number> = {
  перв: 1, втор: 2, трет: 3, четверт: 4, пят: 5, шест: 6, седьм: 7, восьм: 8, девят: 9, десят: 10,
}

function normalize(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е').replace(/[^a-zа-я0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function nameStem(word: string): string {
  for (const ending of endings) {
    if (word.endsWith(ending) && word.length - ending.length >= 2) return word.slice(0, -ending.length)
  }
  return word
}

function stemsMatch(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 3 && long.startsWith(short)
}

function defaultNumber(name: string): number | null {
  const match = /^игрок\s+(\d+)$/.exec(normalize(name))
  return match ? Number(match[1]) : null
}

/** Ровно один кандидат → его id; иначе null (0 или несколько совпадений). */
export function matchSpokenPlayer(transcript: string, candidates: Array<{ id: PlayerId; name: string }>): PlayerId | null {
  const words = normalize(transcript).split(' ').filter(Boolean)
  if (!words.length) return null
  const stems = words.map(nameStem)
  const hits = new Set<PlayerId>()
  for (const candidate of candidates) {
    const number = defaultNumber(candidate.name)
    if (number !== null) {
      const digits = words.some((word) => word === String(number))
      const ordinal = stems.some((stem) => Object.entries(ordinals).some(([root, value]) => value === number && stem.startsWith(root)))
      if (digits || ordinal) hits.add(candidate.id)
      continue
    }
    const nameStems = normalize(candidate.name).split(' ').filter(Boolean).map(nameStem)
    if (nameStems.some((nameStem) => stems.some((stem) => stemsMatch(stem, nameStem)))) hits.add(candidate.id)
  }
  return hits.size === 1 ? [...hits][0]! : null
}

/** Все кандидаты, чьё имя прозвучало (для понятного отказа «себе нельзя»). */
export function spokenPlayers(transcript: string, players: Array<{ id: PlayerId; name: string }>): PlayerId[] {
  return players.filter((player) => matchSpokenPlayer(transcript, [player]) !== null).map((player) => player.id)
}

/** Подсказка ASR: имена кандидатов в нескольких падежах. */
export function nameHints(names: string[]): string {
  const forms = new Set<string>()
  for (const name of names) {
    forms.add(name)
    const stem = name.slice(0, -1)
    if (/[ая]$/i.test(name)) { forms.add(`${stem}е`); forms.add(`${stem}${/я$/i.test(name) ? 'ю' : 'у'}`) }
    else if (/[йь]$/i.test(name)) forms.add(`${stem}ю`)
    else if (!/\d$/.test(name)) forms.add(`${name}у`)
  }
  return [...forms].join(', ')
}
