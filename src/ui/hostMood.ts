import type { LinkStatus } from '../realtime/client.ts'

export type HostMood = 'listen' | 'speak' | 'buzz' | 'think'

const speechPaths = new Set([
  'welcoming',
  'reading',
  'announcing',
  'announcing.speaking',
  'finished',
  'bridging',
  'finalBets.asking',
  'turnCue',
  'falseStartCue',
])

export function hostMood(path: string, link: Pick<LinkStatus, 'host' | 'mic'>): HostMood {
  if (path === 'reading.armed') return 'buzz'
  if (link.host === 'speaking') return 'speak'
  if (path.startsWith('buzzing')) return 'buzz'
  if (
    link.mic === 'live' &&
    (path === 'choosing.listening' ||
      path === 'choosing.clarifying' ||
      path === 'answering.waiting' ||
      path === 'answering.hearing' ||
      path === 'finalBets.hearing')
  ) {
    return 'listen'
  }
  if (path === 'announcing.holding') return 'think'
  if (speechPaths.has(path) || path.startsWith('reading.')) return 'speak'
  return 'think'
}

export const hostCopy: Record<HostMood, { title: string; hint: string }> = {
  listen: { title: 'Можно говорить', hint: 'Ведущая слушает' },
  speak: { title: 'Не говорите', hint: 'Сейчас говорит ведущая' },
  buzz: { title: 'Жмите кнопку', hint: 'Слышу вас, засчитаю только после кнопки' },
  think: { title: 'Не говорите', hint: 'Ведущая думает' },
}

const genericHints = new Set(['ведущая думает', 'сейчас говорит ведущая', 'ведущая слушает'])

function fold(text: string): string {
  return text
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function same(left: string, right: string): boolean {
  return fold(left) === fold(right)
}

function covers(haystack: string, needle: string): boolean {
  const hay = fold(haystack)
  const pin = fold(needle)
  return pin.length >= 4 && hay.includes(pin)
}

type CaptionCluster = 'speak' | 'think' | 'button' | 'listen' | 'pause' | 'stop'

function cluster(text: string): CaptionCluster | null {
  const line = fold(text)
  if (/останов/.test(line)) return 'stop'
  if (/\bпауз/.test(line)) return 'pause'
  if (/жмите/.test(line) && /кноп/.test(line)) return 'button'
  if (/можно говорить|слушает/.test(line)) return 'listen'
  if (/думает|задумал|оценива|разбирает/.test(line)) return 'think'
  if (/не говорите|говорит ведущ|читает вопрос/.test(line)) return 'speak'
  return null
}

function weight(text: string): number {
  const line = fold(text)
  const detail =
    /читает вопрос|оценива|разбирает|только после кнопки|засчитаю|сессия закрыта|микрофон выключен|назовите|выберите тему|отвечает игрок|верно|неверно|время вышло|время на ответ|никто не нажал|повторите/.test(
      line,
    )
  return Math.min(line.length, 48) + (detail ? 40 : 0)
}

function restates(line: string, title: string): boolean {
  const lineCluster = cluster(line)
  const titleCluster = cluster(title)
  if (!lineCluster || lineCluster !== titleCluster) return false
  return weight(line) <= weight(title) + 16
}

export function hostCaption(input: { title: string; hint: string; status: string }): { title: string; lines: string[] } {
  const title = input.title.trim()
  const hint = input.hint.trim()
  const status = input.status.trim()
  const lines: string[] = []
  if (hint && !same(hint, title)) lines.push(hint)
  const glued = Boolean(hint && covers(status, title) && covers(status, hint))
  if (status && !same(status, title) && !same(status, hint) && !glued && !restates(status, title)) {
    const related =
      genericHints.has(fold(hint)) ||
      (cluster(hint) !== null && cluster(hint) === cluster(status)) ||
      covers(hint, status) ||
      covers(status, hint)
    if (lines.length > 0 && related) {
      if (weight(status) >= weight(lines[0])) lines[0] = status
    } else if (lines.length < 2) {
      lines.push(status)
    }
  }
  return { title, lines: lines.slice(0, 2) }
}
