import type { LinkStatus } from '../realtime/client.ts'

export function linkTitle(connection: LinkStatus['connection']): string {
  if (connection === 'connected') return 'на связи'
  if (connection === 'connecting') return 'подключение'
  if (connection === 'error') return 'связь прервалась'
  return 'нет связи'
}

export function linkLive(connection: LinkStatus['connection']): boolean {
  return connection === 'connected'
}

export function micTitle(mic: LinkStatus['mic']): string {
  if (mic === 'live') return 'микрофон открыт'
  if (mic === 'requesting') return 'запрос микрофона'
  if (mic === 'error') return 'микрофон недоступен'
  return 'микрофон выключен'
}

export function micLive(mic: LinkStatus['mic']): boolean {
  return mic === 'live'
}

export function hostTitle(host: LinkStatus['host']): string {
  if (host === 'speaking') return 'ведущая говорит'
  if (host === 'blocked') return 'звук ведущей заблокирован'
  return 'ведущая молчит'
}

export function hostSpeaking(host: LinkStatus['host']): boolean {
  return host === 'speaking'
}
