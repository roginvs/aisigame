export type MicMixer = {
  setRemoteStreams: (streams: Array<{ id: string; stream: MediaStream }>) => void
  setLocalMic: (stream: MediaStream | null) => void
  outputStream: () => MediaStream | null
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
  if (root === 'answering') return answererParticipantId
  if (root === 'finalBets') return bettorParticipantId
  if (!hearTurnOnly) return null
  // Лобби / меню: все; уже в партии вне выбора, ответа и ставки — тишина для модели.
  if (root === 'startMenu' || root === 'connecting' || root === 'failed') return null
  return false
}

/** Отбирает удалённые потоки и локальный микрофон для микса модели. */
export function streamsForModelHear(input: {
  remotes: Array<{ id: string; stream: MediaStream }>
  localId: string
  localStream: MediaStream | null
  focusParticipantId: ModelHearFocus
}): { remotes: Array<{ id: string; stream: MediaStream }>; local: MediaStream | null } {
  const focus = input.focusParticipantId
  if (focus === false) {
    return { remotes: [], local: null }
  }
  if (!focus) {
    return { remotes: input.remotes, local: input.localStream }
  }
  return {
    remotes: input.remotes.filter((item) => item.id === focus),
    local: focus === input.localId ? input.localStream : null,
  }
}

type MixerSource = {
  node: MediaStreamAudioSourceNode
  /** Только клоны: оригинал микрофона останавливать нельзя. */
  clones: MediaStreamTrack[]
  fingerprint: string
}

/**
 * Смешивает локальный и удалённые микрофоны для модели.
 * Удалённые дорожки клонируются: оригинал остаётся у Jitsi и у `<audio>`,
 * а Web Audio в Chromium на общем треке с HTML-элементом часто молчит.
 * Локальный микрофон не клонируем — он не идёт в `<audio>`, а клон не
 * подчиняется Jitsi `mute()` и продолжал бы кормить модель при «мик выкл.».
 */
export function createMicMixer(): MicMixer {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const sources = new Map<string, MixerSource>()

  function drop(key: string): void {
    const existing = sources.get(key)
    if (!existing) return
    existing.node.disconnect()
    for (const clone of existing.clones) {
      try {
        clone.stop()
      } catch {
        // Уже остановлен.
      }
    }
    sources.delete(key)
  }

  function sync(key: string, stream: MediaStream | null, cloneTracks: boolean): void {
    if (!stream) {
      drop(key)
      return
    }
    // enabled=false (часто после mute) не кормим модель; иначе clone() навсегда
    // копирует выключенное состояние, а оригинал после unmute уже слышен в <audio>.
    const originals = stream
      .getAudioTracks()
      .filter((track) => track.readyState === 'live' && track.enabled !== false)
    if (originals.length === 0) {
      drop(key)
      return
    }
    const fingerprint = `${cloneTracks ? 'c' : 'o'}:${originals
      .map((track) => `${track.id}:${track.enabled !== false ? '1' : '0'}`)
      .join(',')}`
    const existing = sources.get(key)
    if (existing?.fingerprint === fingerprint) return
    drop(key)
    const tracks = cloneTracks ? originals.map((track) => track.clone()) : originals
    const node = context.createMediaStreamSource(new MediaStream(tracks))
    node.connect(destination)
    sources.set(key, {
      node,
      clones: cloneTracks ? tracks : [],
      fingerprint,
    })
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  return {
    setRemoteStreams(streams) {
      const keys = new Set<string>()
      for (const item of streams) {
        const key = `remote-${item.id}`
        keys.add(key)
        sync(key, item.stream, true)
      }
      for (const key of [...sources.keys()]) {
        if (key.startsWith('remote-') && !keys.has(key)) drop(key)
      }
    },
    setLocalMic(stream) {
      sync('local', stream, false)
    },
    outputStream: () => destination.stream,
    dispose() {
      for (const key of [...sources.keys()]) drop(key)
      void context.close()
    },
  }
}
