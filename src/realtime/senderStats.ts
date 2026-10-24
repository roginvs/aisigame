import { pushTrace } from '../debug/trace.ts'

/** Сводка исходящего аудио WebRTC к модели. Поля null — отчёт их не прислал. */
export type ModelSenderStats = {
  packetsSent: number | null
  bytesSent: number | null
  packetsLost: number | null
  jitter: number | null
  roundTripTime: number | null
}

type StatRecord = {
  type?: string
  kind?: string
  mediaType?: string
  packetsSent?: number
  bytesSent?: number
  packetsLost?: number
  jitter?: number
  roundTripTime?: number
}

type AudioSenderLike = {
  track: { kind: string } | null
  getStats(): Promise<{ forEach(callback: (report: object) => void): void }>
}

function audioKind(report: StatRecord): boolean {
  return report.kind === 'audio' || report.mediaType === 'audio'
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Один вызов getStats у аудио-отправителя. Видео и чужие отчёты не читает.
 * Нет отправителя или getStats отказал — null, исключение наружу не идёт.
 */
export async function summarizeAudioSender(pc: {
  getSenders(): readonly AudioSenderLike[]
}): Promise<ModelSenderStats | null> {
  const sender = pc.getSenders().find((item) => item.track?.kind === 'audio')
  if (!sender) return null
  let stats: { forEach(callback: (report: object) => void): void }
  try {
    stats = await sender.getStats()
  } catch {
    return null
  }
  const found: { outbound: StatRecord | null; remote: StatRecord | null } = { outbound: null, remote: null }
  stats.forEach((report) => {
    if (!report || typeof report !== 'object') return
    const item = report as StatRecord
    if (!audioKind(item)) return
    if (item.type === 'outbound-rtp') found.outbound = item
    else if (item.type === 'remote-inbound-rtp') found.remote = item
  })
  if (!found.outbound && !found.remote) return null
  return {
    packetsSent: finite(found.outbound?.packetsSent),
    bytesSent: finite(found.outbound?.bytesSent),
    packetsLost: finite(found.remote?.packetsLost),
    jitter: finite(found.remote?.jitter),
    roundTripTime: finite(found.remote?.roundTripTime),
  }
}

/**
 * Закрытие окна слушания: одна строка в debug-trace, если снимок есть.
 * Ошибка и пустой снимок молча пропускаются — на партию это не влияет.
 */
export function noteModelSenderStats(read: (() => Promise<ModelSenderStats | null>) | undefined): void {
  if (!read) return
  void Promise.resolve()
    .then(read)
    .then((stats) => {
      if (stats) pushTrace('note', 'Модель: отправитель звука', stats)
    })
    .catch(() => undefined)
}
