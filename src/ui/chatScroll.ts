export type PinEntry = {
  id: number
  title: string
  detail?: unknown
}

/** Ключ списка на экране: новая строка, срез на лимите и выросший текст. */
export function chatPinKey(entries: readonly PinEntry[]): string {
  let chars = 0
  let lastId = 0
  for (const entry of entries) {
    lastId = entry.id
    chars += entry.title.length
    chars += detailChars(entry.detail)
  }
  return `${entries.length}:${lastId}:${chars}`
}

export function pinColumn(node: { scrollTop: number; scrollHeight: number }): void {
  node.scrollTop = node.scrollHeight
}

/** Уже у нижнего края. Новую строку это не отменяет: её докручивают отдельно. */
export function isAtTail(
  node: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 32,
): boolean {
  return node.scrollHeight - node.clientHeight - node.scrollTop <= slack
}

function detailChars(detail: unknown): number {
  if (!detail || typeof detail !== 'object') return 0
  let size = 0
  if ('text' in detail && typeof detail.text === 'string') size += detail.text.length
  if ('note' in detail && typeof detail.note === 'string') size += detail.note.length
  return size
}
