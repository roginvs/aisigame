import { levelOf } from './hearWindow.ts'
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
  /** Уровни каждого источника до гейна (для диагностики окна «модель слушает»). */
  levels: () => Array<{ key: string; rms: number; peak: number; clip: number; gain: 0 | 1; postRms: number }>
  /** Уровень шины — тот же узел, что рисует индикатор «что слышит модель» и уходит в модель. */
  busLevel: () => { rms: number; peak: number; clip: number }
  /** Пересоздать источник (новый клон) при следующем update — лечение «немого клона». */
  reattach: (key: string) => void
  dispose: () => void
}

/** Событие источника микса для trace: подключён, заменён (новая дорожка/клон), снят. */
export type MixerSourceEvent = { key: string; kind: 'added' | 'replaced' | 'removed'; tracks: string }

/**
 * Кого модель слышит в миксе конференции.
 * - `null` — все (лобби; без «Меньше слышать» — окно кнопки, ставки и т.п.)
 * - `string` или список id — живые дорожки одного игрока (`choosing.*` / `answering.*` / `finalBets.*`)
 * - `false` — никого («Меньше слышать» вне выбора, ответа и ставки, либо id хода ещё нет)
 * Пустой список — ход есть, но ни одной дорожки этого игрока: тишина, не чужие.
 */
export type ModelHearFocus = string | readonly string[] | null | false

export function focusedModelParticipantId(
  phase: string,
  chooserParticipantId: string | null,
  answererParticipantId: string | null,
  hearTurnOnly = false,
  bettorParticipantId: string | null = null,
): string | null | false {
  const root = phase.split('.')[0] ?? phase
  // Нет id на ходе — тишина, не «все»: иначе модель слышит чужого (инвариант 14).
  if (root === 'choosing') return chooserParticipantId ?? false
  if (root === 'answering' || root === 'appealCue') return answererParticipantId ?? false
  if (root === 'finalBets' || root === 'cat' || root === 'auction') return bettorParticipantId ?? false
  if (!hearTurnOnly) return null
  // Лобби / меню: все; уже в партии вне выбора, ответа и ставки — тишина для модели.
  if (root === 'startMenu' || root === 'connecting' || root === 'failed') return null
  return false
}

/**
 * Ключ источника → 0/1.
 * `fallback` — фокус назвал участника, но живой незаглушённой дорожки с этим id нет.
 * Чужие при этом остаются на 0: открывать всех значило слышать не того игрока.
 */
export type ModelHearGains = { gains: Map<string, 0 | 1>; fallback: boolean }

/**
 * Какие источники модель слышит. Чистая функция: фокус — участник, «никто» (false)
 * или все (null). Заглушённые (muted/не live) всегда 0. Конкретный id — только он,
 * даже если его дорожки нет (устаревший id, mute, смена владельца): чужой микрофон
 * не подменяет отвечающего. Нет id (`null`) — по-прежнему все живые.
 */
function focusIdList(focus: ModelHearFocus): readonly string[] | null | false {
  if (focus === false || focus === null) return focus
  return typeof focus === 'string' ? [focus] : focus
}

export function modelHearGains(input: {
  remotes: Array<{ key: string; participantId: string; audible: boolean }>
  local: { participantId: string; audible: boolean }
  focus: ModelHearFocus
}): ModelHearGains {
  const gains = new Map<string, 0 | 1>()
  const { focus } = input
  const ids = focusIdList(focus)
  const all = [
    ...input.remotes,
    { key: LOCAL_KEY, participantId: input.local.participantId, audible: input.local.audible },
  ]
  let fallback = false
  let pick: (item: { participantId: string }) => boolean
  if (ids === false) pick = () => false
  else if (ids === null) pick = () => true
  else if (ids.some((id) => all.some((item) => item.audible && item.participantId === id))) {
    pick = (item) => ids.includes(item.participantId)
  } else {
    fallback = true
    pick = () => false
  }
  for (const item of all) gains.set(item.key, item.audible && pick(item) ? 1 : 0)
  return { gains, fallback }
}

/**
 * Все id соединений одного игрока, чьи дорожки можно открыть модели.
 * Перезаход: новый endpoint и ещё живая старая дорожка (previousBoundIds), пока её id не отдан другому clientId.
 * Чужой id из пар не попадает никогда.
 */
export function hearParticipantIds(input: {
  clientId: string
  liveEndpointId: string | null
  pairs: readonly (readonly [string, string])[]
  selfParticipantId: string | null
  liveOwnerIds: readonly string[]
  previousBoundIds: readonly string[]
}): string[] {
  const foreign = new Set<string>()
  for (const [id, owner] of input.pairs) if (owner !== input.clientId) foreign.add(id)
  const mine = new Set<string>()
  const take = (id: string | null) => {
    if (!id || foreign.has(id)) return
    mine.add(id)
  }
  take(input.liveEndpointId)
  take(input.selfParticipantId)
  for (const [id, owner] of input.pairs) if (owner === input.clientId) take(id)
  const live = new Set(input.liveOwnerIds)
  for (const id of input.previousBoundIds) if (live.has(id)) take(id)
  return [...mine]
}

/** Смена отвечающего сбрасывает прилипшие id предыдущего. Тот же игрок их сохраняет. */
export function nextHearBinding(
  previous: { clientId: string | null; ids: readonly string[] },
  clientId: string | null,
  resolve: (previousBoundIds: readonly string[]) => readonly string[],
): { clientId: string | null; ids: string[] } {
  if (!clientId) return { clientId: null, ids: [] }
  const prev = previous.clientId === clientId ? previous.ids : []
  return { clientId, ids: [...resolve(prev)] }
}

export const LOCAL_KEY = 'local'
/** Постоянная времени рампы гейна: ~15 мс до 1/e, без щелчков. */
const GAIN_TIME_CONSTANT_S = 0.005

type MixerSource = {
  node: MediaStreamAudioSourceNode
  gain: GainNode
  analyser: AnalyserNode | null
  /** После гейна: ровно то, что этот источник добавляет в поток модели. */
  postAnalyser: AnalyserNode | null
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
export function createMicMixer(onSource: (event: MixerSourceEvent) => void = () => undefined): MicMixer {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const sources = new Map<string, MixerSource>()
  // Шина: все гейны → bus → destination (модель) и, по запросу, → analyser (индикатор).
  const bus = context.createGain()
  bus.connect(destination)
  let analyser: AnalyserNode | null = null

  const forceReattach = new Set<string>()

  function drop(key: string, quiet = false): void {
    const existing = sources.get(key)
    if (!existing) return
    if (!quiet) onSource({ key, kind: 'removed', tracks: existing.fingerprint })
    existing.node.disconnect()
    existing.gain.disconnect()
    existing.analyser?.disconnect()
    existing.postAnalyser?.disconnect()
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
    const forced = forceReattach.delete(key)
    if (existing?.fingerprint === fingerprint && !forced) return true
    drop(key, true)
    const tracks = cloneTracks ? originals.map((track) => track.clone()) : originals
    const node = context.createMediaStreamSource(new MediaStream(tracks))
    const gain = context.createGain()
    gain.gain.value = 0
    node.connect(gain)
    gain.connect(bus)
    // Анализатор до гейна: видно, есть ли звук у источника, даже когда фокус его глушит.
    let analyser: AnalyserNode | null = null
    let postAnalyser: AnalyserNode | null = null
    if (typeof context.createAnalyser === 'function') {
      analyser = context.createAnalyser()
      analyser.fftSize = 1024
      node.connect(analyser)
      postAnalyser = context.createAnalyser()
      postAnalyser.fftSize = 1024
      gain.connect(postAnalyser)
    }
    sources.set(key, { node, gain, analyser, postAnalyser, clones: cloneTracks ? tracks : [], fingerprint, level: 0 })
    onSource({ key, kind: existing ? 'replaced' : 'added', tracks: fingerprint })
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
    levels() {
      const out: Array<{ key: string; rms: number; peak: number; clip: number; gain: 0 | 1; postRms: number }> = []
      const read = (tap: AnalyserNode | null) => {
        if (!tap || typeof tap.getFloatTimeDomainData !== 'function') return { rms: 0, peak: 0, clip: 0 }
        const data = new Float32Array(tap.fftSize)
        tap.getFloatTimeDomainData(data)
        return levelOf(data)
      }
      for (const [key, source] of sources) {
        const { rms, peak, clip } = read(source.analyser)
        out.push({ key, rms, peak, clip, gain: source.level, postRms: read(source.postAnalyser).rms })
      }
      return out
    },
    busLevel() {
      const tap = this.meter()
      if (typeof tap.getFloatTimeDomainData !== 'function') return { rms: 0, peak: 0, clip: 0 }
      const data = new Float32Array(tap.fftSize)
      tap.getFloatTimeDomainData(data)
      return levelOf(data)
    },
    reattach(key) {
      if (sources.has(key)) forceReattach.add(key)
    },
    dispose() {
      for (const key of [...sources.keys()]) drop(key, true)
      void context.close()
    },
  }
}
