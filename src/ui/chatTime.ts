/** Локальное время сообщения с точностью до секунды: `22:15:03`. */
export function formatChatTime(at: string | undefined): string {
  if (!at) return ''
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
