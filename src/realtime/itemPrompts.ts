import { echoesAnswerPrompt } from '../game/answerPrompt.ts'
import { echoesChoicePrompt } from '../game/choicePrompt.ts'
import { echoesTranscriptionPrompt } from '../game/promptEcho.ts'

/** Сколько реплик помнить (старые выталкиваются). */
const itemPromptsLimit = 50

/**
 * Подсказки распознаванию, действовавшие для каждой реплики (item_id).
 *
 * Расшифровка приходит через 1–3 с после конца речи; к этому времени игра часто
 * уже сменила подсказку (например, после выбора ячейки — на пустую при чтении).
 * Сравнивать «эхо подсказки» с текущей подсказкой нельзя: каталог, который
 * распознавание выдумало на шуме, тогда проходит в чат. Поэтому для реплики
 * запоминаем все подсказки от speech_started до прихода расшифровки.
 */
export class ItemPrompts {
  private current = ''
  private byItem = new Map<string, Set<string>>()
  /** Реплики, расшифровки которых ещё нет: им достаются и новые подсказки. */
  private open = new Set<string>()

  get prompt(): string {
    return this.current
  }

  set(prompt: string): void {
    this.current = prompt
    for (const itemId of this.open) this.byItem.get(itemId)?.add(prompt)
  }

  started(itemId: string | null): void {
    if (!itemId) return
    const known = this.byItem.get(itemId) ?? new Set<string>()
    known.add(this.current)
    this.byItem.set(itemId, known)
    this.open.add(itemId)
    while (this.byItem.size > itemPromptsLimit) {
      const oldest = this.byItem.keys().next().value!
      this.byItem.delete(oldest)
      this.open.delete(oldest)
    }
  }

  /** Расшифровка пришла: подсказки реплики больше не пополняются. */
  finished(itemId: string): void {
    this.open.delete(itemId)
  }

  /** Подсказки реплики плюс текущая (если speech_started не пришёл). */
  promptsFor(itemId: string | null): string[] {
    const known = itemId ? this.byItem.get(itemId) : undefined
    return [...new Set([...(known ?? []), this.current])]
  }

  reset(): void {
    this.current = ''
    this.byItem.clear()
    this.open.clear()
  }
}

/** Расшифровка повторила одну из подсказок (каталог, эталоны, редкие слова). */
export function echoesAnyPrompt(text: string, prompts: readonly string[]): boolean {
  return prompts.some((prompt) =>
    echoesChoicePrompt(text, prompt) || echoesAnswerPrompt(text, prompt) || echoesTranscriptionPrompt(text, prompt))
}
