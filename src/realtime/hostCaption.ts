import { hostMsPerCharDefault } from '../options.ts'

/**
 * Подпись реплики ведущей, которую мы сами оборвали: в чат — только то, что успело прозвучать, и «…».
 * Позиция — по звуку: `audio_end_ms` из `conversation.item.truncated` (сколько мс реплики сыграно),
 * иначе время от `output_audio_buffer.started` до обрыва. В символы переводит темп речи этой сессии
 * (мс на символ по целиком доигранным репликам), смысл текста не разбирается.
 * Пусто — не прозвучало ни одного целого слова: в чат ничего.
 */
export function cutCaption(line: string, playedMs: number, msPerChar: number): string {
  const text = line.trim()
  if (!text) return ''
  const chars = Math.floor(Math.max(0, playedMs) / Math.max(1, msPerChar))
  if (chars >= text.length) return text
  // Режем по границе слова не дальше сыгранной позиции: недоигранное слово не показываем.
  let head = text.slice(0, chars)
  if (!/\s/u.test(text[chars] ?? ' ')) {
    const space = head.search(/\s\S*$/u)
    head = space >= 0 ? head.slice(0, space) : ''
  }
  const clean = head.replace(/[\s,;:—–-]+$/u, '')
  return clean ? `${clean}…` : ''
}

/** Темп ведущей в этой сессии: мс звука на символ текста по репликам, доигранным до `stopped`. */
export class HostPace {
  private ms = hostMsPerCharDefault
  private samples = 0
  get msPerChar(): number {
    return this.ms
  }
  /** Реплика доиграла: длительность звука и её текст. Короткие и странные замеры не учитываем. */
  note(durationMs: number, text: string): void {
    const chars = text.trim().length
    if (chars < 20 || durationMs <= 0) return
    const sample = durationMs / chars
    if (sample < 30 || sample > 250) return
    this.samples += 1
    const weight = Math.max(0.2, 1 / this.samples)
    this.ms = this.ms * (1 - weight) + sample * weight
  }
}
