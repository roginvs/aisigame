import { CHUNK_BYTES } from './chunks.ts'

export type TransferPace = {
  startedAt: number
  lastBytes: number
  lastAt: number
  emaBps: number
}

export type PackProgressView = {
  percent: number
  downloadBps: number | null
  etaSeconds: number | null
}

/** Обновляет оценку скорости по ACK (nextIndex — первый ещё не принятый кусок). */
export function paceAfterAck(
  previous: TransferPace | undefined,
  nextIndex: number,
  packBytes: number,
  now = Date.now(),
): { pace: TransferPace | null; view: PackProgressView } {
  const totalChunks = Math.max(1, Math.ceil(Math.max(0, packBytes) / CHUNK_BYTES))
  if (nextIndex <= 0) {
    return {
      pace: { startedAt: now, lastBytes: 0, lastAt: now, emaBps: 0 },
      view: { percent: 0, downloadBps: null, etaSeconds: null },
    }
  }
  if (nextIndex >= totalChunks) {
    return {
      pace: null,
      view: { percent: 100, downloadBps: null, etaSeconds: null },
    }
  }

  const bytes = Math.min(packBytes, nextIndex * CHUNK_BYTES)
  const percent = Math.min(99, Math.floor((nextIndex / totalChunks) * 100))
  let pace: TransferPace = previous ?? { startedAt: now, lastBytes: 0, lastAt: now, emaBps: 0 }
  if (!previous || previous.lastBytes > bytes) {
    pace = { startedAt: now, lastBytes: 0, lastAt: now, emaBps: 0 }
  }

  const stepDt = (now - pace.lastAt) / 1000
  let emaBps = pace.emaBps
  if (stepDt >= 0.05 && bytes > pace.lastBytes) {
    const instant = (bytes - pace.lastBytes) / stepDt
    emaBps = emaBps <= 0 ? instant : emaBps * 0.7 + instant * 0.3
  }

  const overallDt = (now - pace.startedAt) / 1000
  const overall = overallDt >= 0.25 && bytes > 0 ? bytes / overallDt : 0
  const downloadBps = emaBps > 0 ? emaBps : overall > 0 ? overall : null
  const remaining = Math.max(0, packBytes - bytes)
  const etaSeconds =
    downloadBps && downloadBps > 0 && remaining > 0 ? Math.max(1, Math.ceil(remaining / downloadBps)) : null

  return {
    pace: { startedAt: pace.startedAt, lastBytes: bytes, lastAt: now, emaBps },
    view: { percent, downloadBps, etaSeconds },
  }
}

export function formatSpeed(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return ''
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(bps >= 10_000_000 ? 0 : 1)} МБ/с`
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} КБ/с`
  return `${Math.round(bps)} Б/с`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `~${Math.round(seconds)} с`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `~${minutes} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `~${hours} ч ${rest} мин` : `~${hours} ч`
}

/** Строка статуса загрузки на карточке лобби. */
export function packProgressLabel(input: {
  percent: number
  hashOk: boolean
  ready: boolean
  downloadBps?: number | null
  etaSeconds?: number | null
}): string {
  if (input.hashOk) return input.ready ? 'Пакет сверен · готов' : 'Пакет сверен'
  if (input.percent >= 99) return 'Сверка…'
  const parts = [`Загрузка ${input.percent}%`]
  const speed = formatSpeed(input.downloadBps)
  const eta = formatEta(input.etaSeconds)
  if (speed) parts.push(speed)
  if (eta) parts.push(`ещё ${eta}`)
  if (input.ready) parts.push('готов')
  return parts.join(' · ')
}
