/** Машина читает это в конце окна ответа. Конференция ставит true, пока звук отвечающего не доходит до модели. */
let source: () => boolean = () => false

export const FOCUS_UNHEARD_REASON = 'не слышно дорожку отвечающего'

export function setFocusUnheard(next: () => boolean): void {
  source = next
}

export function focusUnheard(): boolean {
  return source()
}
