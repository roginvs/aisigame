/** Удалённая дорожка в миксе модели. key — стабильный ключ дорожки, не участника. */
export type MixerRemote = {
  key: string
  /** Текущий владелец (track.getParticipantId() в момент синка). */
  participantId: string
  stream: MediaStream
  /** Jitsi isMuted: гейн 0 (консервативно), источник остаётся подключён. */
  muted: boolean
}

export type MixerLocal = { participantId: string; stream: MediaStream | null; live: boolean }

export type MicMixer = {
  /**
   * Синхронизирует набор источников (добавляет/убирает только при появлении,
   * исчезновении или смене дорожки) и выставляет гейны по фокусу.
   */
  update: (input: { remotes: MixerRemote[]; local: MixerLocal; focus: ModelHearFocus }) => ModelHearGains
  outputStream: () => MediaStream | null
  /** AnalyserNode на той же шине, что уходит модели (только отвод, поток не меняет). */
  meter: () => AnalyserNode
  dispose: () => void
}

/**
 * Кого модель слышит в миксе конференции.
 * - `null` — все (лобби; без «Меньше слышать» — окно кнопки, ставки и т.п.)
 * - `string` — один участник (`choosing.*` / `answering.*` / `finalBets.*`)
 * - `false` — никого («Меньше слышать» вне выбора, ответа и ставки: глухо, не «чуть тише»)
 * Если Jitsi id ещё не известен на выборе/ответе, оставляем всех (fail open).
 */
export type ModelHearFocus = string | null | false

export function focusedModelParticipantId(
  phase: string,
  chooserParticipantId: string | null,
  answererParticipantId: string | null,
  hearTurnOnly = false,
  bettorParticipantId: string | null = null,
): ModelHearFocus {
  const root = phase.split('.')[0] ?? phase
  if (root === 'choosing') return chooserParticipantId
  if (root === 'answering' || root === 'appealCue') return answererParticipantId
  if (root === 'finalBets' || root === 'cat' || root === 'auction') return bettorParticipantId
  if (!hearTurnOnly) return null
  // Лобби / меню: все; уже в партии вне выбора, ответа и ставки — тишина для модели.
  if (root === 'startMenu' || root === 'connecting' || root === 'failed') return null
  return false
}

/** Ключ источника → 0/1 и признак fallback (фокус без живой дорожки → слышим всех). */
export type ModelHearGains = { gains: Map<string, 0 | 1>; fallback: boolean }

/**
 * Какие источники модель слышит. Чистая функция: фокус — участник, «никто» (false)
 * или все (null). Заглушённые (muted/не live) всегда 0. Если фокус указывает на
 * участника без живой незаглушённой дорожки (устаревший id, другая вкладка,
 * дорожка ушла к другому владельцу) — открываем всех живых: лучше лишний шум,
 * чем модель, которая не слышит отвечающего.
 */
export function modelHearGains(input: {
  remotes: Array<{ key: string; participantId: string; audible: boolean }>
  local: { participantId: string; audible: boolean }
  focus: ModelHearFocus
}): ModelHearGains {
  const gains = new Map<string, 0 | 1>()
  const { focus } = input
  const all = [
    ...input.remotes,
    { key: LOCAL_KEY, participantId: input.local.participantId, audible: input.local.audible },
  ]
  let fallback = false
  let pick: (item: { participantId: string }) => boolean
  if (focus === false) pick = () => false
  else if (focus === null) pick = () => true
  else if (all.some((item) => item.audible && item.participantId === focus)) pick = (item) => item.participantId === focus
  else {
    fallback = true
    pick = () => true
  }
  for (const item of all) gains.set(item.key, item.audible && pick(item) ? 1 : 0)
  return { gains, fallback }
}

export const LOCAL_KEY = 'local'
/** Постоянная времени рампы гейна: ~15 мс до 1/e, без щелчков. */
const GAIN_TIME_CONSTANT_S = 0.005

type MixerSource = {
  node: MediaStreamAudioSourceNode
  gain: GainNode
  /** Только клоны: оригинал микрофона останавливать нельзя. */
  clones: MediaStreamTrack[]
  fingerprint: string
  level: 0 | 1
}

function liveAudioTracks(stream: MediaStream | null): MediaStreamTrack[] {
  if (!stream) return []
  // enabled=false не кормим: clone() навсегда копирует выключенное состояние.
  return stream.getAudioTracks().filter((track) => track.readyState === 'live' && track.enabled !== false)
}

/**
 * Микс для модели: каждая живая дорожка постоянно подключена через свой GainNode.
 * Фокус, «Меньше слышать» и mute — только смена гейна (быстрая рампа), источники
 * пересоздаются лишь при появлении/исчезновении/замене дорожки.
 * Удалённые дорожки клонируются: оригинал остаётся у Jitsi и у `<audio>`,
 * а Web Audio в Chromium на общем треке с HTML-элементом часто молчит.
 * Локальный микрофон не клонируем: клон не подчиняется Jitsi `mute()`.
 */
export function createMicMixer(): MicMixer {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const sources = new Map<string, MixerSource>()
  // Шина: все гейны → bus → destination (модель) и, по запросу, → analyser (индикатор).
  const bus = context.createGain()
  bus.connect(destination)
  let analyser: AnalyserNode | null = null

  function drop(key: string): void {
    const existing = sources.get(key)
    if (!existing) return
    existing.node.disconnect()
    existing.gain.disconnect()
    for (const clone of existing.clones) {
      try {
        clone.stop()
      } catch {
        // Уже остановлен.
      }
    }
    sources.delete(key)
  }

  /** true — источник есть (живой). */
  function ensure(key: string, stream: MediaStream | null, cloneTracks: boolean): boolean {
    const originals = liveAudioTracks(stream)
    if (originals.length === 0) {
      drop(key)
      return false
    }
    const fingerprint = `${cloneTracks ? 'c' : 'o'}:${originals.map((track) => track.id).join(',')}`
    const existing = sources.get(key)
    if (existing?.fingerprint === fingerprint) return true
    drop(key)
    const tracks = cloneTracks ? originals.map((track) => track.clone()) : originals
    const node = context.createMediaStreamSource(new MediaStream(tracks))
    const gain = context.createGain()
    gain.gain.value = 0
    node.connect(gain)
    gain.connect(bus)
    sources.set(key, { node, gain, clones: cloneTracks ? tracks : [], fingerprint, level: 0 })
    return true
  }

  function setLevel(source: MixerSource, level: 0 | 1): void {
    if (source.level === level) return
    source.level = level
    const param = source.gain.gain
    const now = context.currentTime
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now)
    if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(level, now, GAIN_TIME_CONSTANT_S)
    else param.value = level
  }

  return {
    update({ remotes, local, focus }) {
      const keep = new Set<string>()
      const items: Array<{ key: string; participantId: string; audible: boolean }> = []
      for (const remote of remotes) {
        const key = `remote-${remote.key}`
        keep.add(key)
        const live = ensure(key, remote.stream, true)
        items.push({ key, participantId: remote.participantId, audible: live && !remote.muted })
      }
      for (const key of [...sources.keys()]) {
        if (key.startsWith('remote-') && !keep.has(key)) drop(key)
      }
      const localLive = ensure(LOCAL_KEY, local.stream, false)
      const result = modelHearGains({
        remotes: items,
        local: { participantId: local.participantId, audible: localLive && local.live },
        focus,
      })
      for (const [key, level] of result.gains) {
        const source = sources.get(key)
        if (source) setLevel(source, level)
      }
      if (context.state === 'suspended') void context.resume().catch(() => undefined)
      return result
    },
    outputStream: () => destination.stream,
    meter() {
      if (!analyser) {
        analyser = context.createAnalyser()
        analyser.fftSize = 512
        bus.connect(analyser)
      }
      return analyser
    },
    dispose() {
      for (const key of [...sources.keys()]) drop(key)
      void context.close()
    },
  }
}
