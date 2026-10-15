import { pushTrace } from '../debug/trace.ts'

type AudioSessionHost = {
  audioSession?: { type: string }
}

export type ConferenceAudioSink = {
  setStream: (stream: MediaStream | null) => void
  play: () => Promise<void>
  pause: () => void
  release: () => void
  /** Переподключить тот же поток: браузер заново создаёт вывод звука. */
  refresh?: () => void
}

export type ConferenceAudioOutput = {
  attach: (participantId: string, stream: MediaStream) => void
  remove: (participantId: string) => void
  /** Повторно включить уже привязанные дорожки после жеста или смены аудиосессии. */
  resume: () => void
  dispose: () => void
}

const poolLimit = 8
/**
 * Короткий тихий WAV. Его `play()` в том же клике, что вход в комнату,
 * разрешает этому элементу позже играть WebRTC. Пустой элемент жест не запоминает.
 */
const silentWav =
  'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const pool: ConferenceAudioSink[] = []
const active = new Set<ConferenceAudioSink>()
let retryInstalled = false

/**
 * Динамик, даже если на iPhone включён беззвучный режим.
 * `play-and-record` уводит звук в разговорный динамик у уха, поэтому его не ставим.
 */
export function preferConferenceSpeaker(host: AudioSessionHost | undefined): void {
  const session = host?.audioSession
  if (!session || session.type === 'playback') return
  try {
    session.type = 'playback'
  } catch {
    // Старый браузер принимает не все значения.
  }
}

function sessionHost(): AudioSessionHost | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator as Navigator & AudioSessionHost
}

/** Вызвать синхронно из клика входа: создаёт элементы и сразу их играет. */
export function primeConferencePlayback(): void {
  preferConferenceSpeaker(sessionHost())
  if (typeof document === 'undefined' || !document.body) return
  installGestureRetry()
  while (pool.length + active.size < poolLimit) {
    const sink = createDomSink()
    sink.prime()
    pool.push(sink)
  }
  for (const sink of active) void sink.play().catch(() => undefined)
}

export function conferenceAudioStream(track: {
  getOriginalStream?: () => MediaStream | undefined
  getTrack?: () => MediaStreamTrack | undefined
}): MediaStream | null {
  const original = track.getOriginalStream?.()
  if (original && original.getAudioTracks().length > 0) return original
  const media = track.getTrack?.()
  if (!media || media.kind !== 'audio') return null
  return new MediaStream([media])
}

/**
 * Проигрывает удалённые WebRTC-дорожки через `<audio>`.
 * Один `MediaStreamAudioSourceNode` на телефоне молчит: Chromium не декодирует
 * поток, который никто не читает элементом, а iOS глушит Web Audio беззвучным режимом.
 * Элементы заранее играет клик входа, иначе поздний `play()` снова блокируется.
 */
export function createConferenceAudioOutput(takeSink: () => ConferenceAudioSink = takeDomSink): ConferenceAudioOutput {
  const sinks = new Map<string, ConferenceAudioSink>()

  function drop(participantId: string): void {
    const sink = sinks.get(participantId)
    if (!sink) return
    sinks.delete(participantId)
    sink.pause()
    sink.setStream(null)
    sink.release()
  }

  return {
    attach(participantId, stream) {
      if (stream.getAudioTracks().length === 0) return
      let sink = sinks.get(participantId)
      if (!sink) {
        sink = takeSink()
        sinks.set(participantId, sink)
      }
      sink.setStream(stream)
      void Promise.resolve(sink.play()).catch((error: unknown) => {
        pushTrace('note', 'Не удалось включить звук конференции', {
          participantId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
    remove: drop,
    resume() {
      for (const sink of sinks.values()) void Promise.resolve(sink.play()).catch(() => undefined)
    },
    dispose() {
      for (const participantId of [...sinks.keys()]) drop(participantId)
    },
  }
}

/** После открытия микрофона: заново создать вывод уже играющих дорожек (Android, поток «звонок»). */
export function refreshConferenceSinks(): void {
  for (const sink of active) sink.refresh?.()
}

function takeDomSink(): ConferenceAudioSink {
  const sink = pool.pop() ?? createDomSink()
  active.add(sink)
  return sink
}

function createDomSink(): ConferenceAudioSink & { prime: () => void } {
  const audio = document.createElement('audio') as HTMLAudioElement & { playsInline: boolean }
  audio.autoplay = true
  audio.playsInline = true
  audio.setAttribute('playsinline', 'true')
  audio.muted = false
  audio.volume = 1
  audio.setAttribute('data-conference-audio', '')
  audio.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.append(audio)

  const sink: ConferenceAudioSink & { prime: () => void } = {
    setStream(stream) {
      if (audio.getAttribute('src')) audio.removeAttribute('src')
      audio.srcObject = stream
      if (!stream) return
      for (const track of stream.getAudioTracks()) {
        track.addEventListener?.(
          'unmute',
          () => {
            void audio.play().catch(() => undefined)
          },
          { once: true },
        )
      }
    },
    play() {
      audio.muted = false
      audio.volume = 1
      return audio.play()
    },
    pause() {
      audio.pause()
    },
    refresh() {
      const stream = audio.srcObject
      if (!stream) return
      audio.srcObject = null
      audio.srcObject = stream
      void audio.play().catch(() => undefined)
    },
    release() {
      active.delete(sink)
      audio.pause()
      audio.srcObject = null
      if (pool.length < poolLimit) pool.push(sink)
      else audio.remove()
    },
    prime() {
      audio.src = silentWav
      void audio.play().catch(() => undefined)
    },
  }
  return sink
}

function installGestureRetry(): void {
  if (retryInstalled) return
  retryInstalled = true
  const retry = () => {
    preferConferenceSpeaker(sessionHost())
    for (const sink of active) void sink.play().catch(() => undefined)
  }
  document.addEventListener('pointerdown', retry, true)
}
