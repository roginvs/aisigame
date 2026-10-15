import type { TraceEntry } from '../debug/trace.ts'

/**
 * Метки событий на шкале «что слышит модель» (только мастер). Источник — trace контроллера
 * и клиента модели (главное состояние), не полученное состояние.
 */
export type MeterMarkerGroup =
  | 'reading' | 'buzzing' | 'answering' | 'choosing' | 'special' | 'appeal' | 'phase'
  | 'hostStart' | 'hostEnd' | 'vadStart' | 'vadStop' | 'transcript' | 'mixer'
  | 'response' | 'cancel' | 'buzzer'

export const meterMarkerColors: Record<MeterMarkerGroup, string> = {
  reading: '#60a5fa',
  buzzing: '#facc15',
  answering: '#f97316',
  choosing: '#a78bfa',
  special: '#f472b6',
  appeal: '#2dd4bf',
  phase: '#94a3b8',
  hostStart: '#ffffff',
  hostEnd: '#6b7280',
  vadStart: '#22d3ee',
  vadStop: '#0e7490',
  transcript: '#a3e635',
  mixer: '#e879f9',
  response: '#34d399',
  cancel: '#ef4444',
  buzzer: '#fde047',
}

export const meterMarkerLegend: Array<[MeterMarkerGroup, string]> = [
  ['reading', 'фаза: чтение'],
  ['buzzing', 'фаза: окно кнопки'],
  ['answering', 'фаза: ответ'],
  ['choosing', 'фаза: выбор'],
  ['special', 'фаза: кот/аукцион/ставки'],
  ['appeal', 'фаза: апелляция'],
  ['phase', 'фаза: прочее'],
  ['buzzer', 'нажата кнопка (толстая)'],
  ['hostStart', 'ведущая начала говорить'],
  ['hostEnd', 'ведущая замолчала'],
  ['vadStart', 'VAD: речь началась'],
  ['vadStop', 'VAD: речь кончилась'],
  ['transcript', 'расшифровка готова'],
  ['mixer', 'фокус микшера'],
  ['response', 'response.create'],
  ['cancel', 'cancel / interrupt / clear'],
]

export function meterLegendText(): string {
  return ['Что слышит модель (выход микшера). Серый отрезок — вход модели закрыт, в модель не ушло. Метки:', ...meterMarkerLegend.map(([g, label]) => `${colorName(g)} — ${label}`)].join('\n')
}

function colorName(group: MeterMarkerGroup): string {
  return `■ ${meterMarkerColors[group]}`
}

export function phaseGroup(path: string): MeterMarkerGroup {
  const root = path.split('.')[0] ?? path
  if (root === 'reading' || root === 'flashing' || root === 'falseStartCue') return 'reading'
  if (root === 'buzzing') return 'buzzing'
  if (root === 'answering' || root === 'judging') return 'answering'
  if (root === 'choosing' || root === 'chooserHandoff') return 'choosing'
  if (root === 'cat' || root === 'auction' || root === 'finalBets' || root === 'finalTheme') return 'special'
  if (root.startsWith('appeal')) return 'appeal'
  return 'phase'
}

/** Классификация записи trace в метку (или null). prevPath — прежняя фаза, чтобы отметить кнопку. */
export function classifyTraceEntry(entry: Pick<TraceEntry, 'kind' | 'title'>, prevPath = ''): MeterMarkerGroup[] {
  const { kind, title } = entry
  if (kind === 'state') {
    const groups: MeterMarkerGroup[] = [phaseGroup(title)]
    const pressed = title === 'answering.waiting' && (prevPath.startsWith('buzzing') || prevPath.startsWith('reading') || prevPath === 'falseStartCue')
    if (pressed) groups.unshift('buzzer')
    return groups
  }
  if (kind === 'in') {
    if (title === 'output_audio_buffer.started') return ['hostStart']
    if (title === 'output_audio_buffer.stopped' || title === 'output_audio_buffer.cleared') return ['hostEnd']
    if (title === 'input_audio_buffer.speech_started') return ['vadStart']
    if (title === 'input_audio_buffer.speech_stopped') return ['vadStop']
    if (title === 'conversation.item.input_audio_transcription.completed') return ['transcript']
    return []
  }
  if (kind === 'out') {
    if (title === 'response.create') return ['response']
    if (title === 'response.cancel' || title === 'output_audio_buffer.clear' || title === 'input_audio_buffer.clear' || title === 'conversation.item.truncate') return ['cancel']
    return []
  }
  if (kind === 'note') {
    if (title.startsWith('Модель: фокус микшера')) return ['mixer']
    return []
  }
  return []
}


export type MeterMarker = { at: number; group: MeterMarkerGroup }

/** Сборщик меток из trace: обрабатывает только новые записи (по id), держит последние maxAgeMs. */
export function createMarkerCollector(maxAgeMs = 20_000) {
  let lastId = 0
  let prevPath = ''
  let markers: MeterMarker[] = []
  return {
    ingest(entries: readonly TraceEntry[], now = Date.now()): MeterMarker[] {
      for (const entry of entries) {
        if (entry.id <= lastId) continue
        lastId = entry.id
        const at = Date.parse(entry.at)
        const groups = classifyTraceEntry(entry, prevPath)
        if (entry.kind === 'state') prevPath = entry.title
        for (const group of groups) markers.push({ at, group })
      }
      markers = markers.filter((marker) => now - marker.at <= maxAgeMs)
      return markers
    },
  }
}
