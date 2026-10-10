import type { LinkStatus } from '../realtime/client.ts'

export function startupStatus(link: Pick<LinkStatus, 'mic'>): string {
  if (link.mic === 'requesting') return 'Открываем микрофон'
  return 'Подключаемся'
}
