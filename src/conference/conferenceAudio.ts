import { diag } from '../debug/diag.ts'
import { pushTrace } from '../debug/trace.ts'
import { conferenceAudioPoolSize } from '../options.ts'

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
  /** Состояние элемента для дампа: muted/paused и жива ли дорожка. */
  playback?: () => { muted: boolean; paused: boolean; volume: number; readyState: number; track: string }
}

export type ConferenceAudioOutput = {
  /** `key` — ключ дорожки; `owner` — имя владельца для служебной строки (не ключ). */
  attach: (participantId: string, stream: MediaStream, owner?: string) => void
  remove: (participantId: string) => void
  /** Повторно включить уже привязанные дорожки после жеста или смены аудиосессии. */
  resume: () => void
  dispose: () => void
}

// Намеренно, не удалять: 12 заготовок `<audio>` разблокируются кликом входа (телефон иначе не пустит play);
// если кончились — элемент создаётся на лету и в «Разговор» уходит строка.
const poolLimit = conferenceAudioPoolSize
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
export type SinkRequest = { key: string; owner: string }
export function createConferenceAudioOutput(takeSink: (request: SinkRequest) => ConferenceAudioSink = takeDomSink): ConferenceAudioOutput {
  const sinks = new Map<string, ConferenceAudioSink>()

  function drop(participantId: string): void {
    const sink = sinks.get(participantId)
    if (!sink) return
    diag('звук', 'дорожка конференции снята с <audio>', { participantId })
    sinks.delete(participantId)
    sink.pause()
    sink.setStream(null)
    sink.release()
  }

  return {
    attach(participantId, stream, owner = '') {
      if (stream.getAudioTracks().length === 0) return
      let sink = sinks.get(participantId)
      if (!sink) {
        sink = takeSink({ key: participantId, owner })
        sinks.set(participantId, sink)
      }
      sink.setStream(stream)
      const tracks = stream.getAudioTracks()
      diag('звук', 'дорожка конференции → <audio>', () => ({
        participantId,
        tracks: tracks.map((track) => `${String(track.id ?? '').slice(0, 8)}:${track.readyState}/${track.muted ? 'muted' : 'live'}`).join(','),
        ...(sink.playback?.() ?? {}),
      }))
      void Promise.resolve(sink.play()).then(() => {
        const state = sink.playback?.()
        if (state) diag('звук', '<audio> после play', () => ({ participantId, ...state }))
      }, (error: unknown) => {
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

type Recreate = (old: HTMLAudioElement, stream: MediaStream) => HTMLAudioElement
let recreate: Recreate = (old) => old
/** beep.ts ставит пересоздание элемента (без цикла импортов). */
export function setConferenceElementRecreate(next: Recreate): void {
  recreate = next
}

/** После открытия микрофона: заново создать вывод уже играющих дорожек (Android, поток «звонок»). */
export function refreshConferenceSinks(): void {
  for (const sink of active) sink.refresh?.()
}

export type SinkCreatedEvent = { key: string; owner: string; poolSize: number; active: number }
const createdListeners = new Set<(event: SinkCreatedEvent) => void>()
/** Заготовки клика входа кончились и `<audio>` создан на лету (его поздний `play()` телефон может не пустить). */
export function subscribeConferenceSinkCreated(listener: (event: SinkCreatedEvent) => void): () => void {
  createdListeners.add(listener)
  return () => createdListeners.delete(listener)
}

/** Экспорт для тестов: пул как в клике входа, без DOM. */
export function takeConferenceSink(request: SinkRequest, create: () => ConferenceAudioSink = createDomSink): ConferenceAudioSink {
  const pooled = pool.pop()
  const sink = pooled ?? create()
  active.add(sink)
  if (!pooled) {
    const event = { key: request.key, owner: request.owner, poolSize: poolLimit, active: active.size }
    pushTrace('note', 'Заготовленные <audio> кончились, создан новый', event)
    for (const listener of createdListeners) listener(event)
  }
  return sink
}

/** Только для тестов: положить заготовки в пул без DOM. */
export function fillConferencePoolForTests(sinks: ConferenceAudioSink[]): void {
  pool.length = 0
  active.clear()
  pool.push(...sinks)
}

function takeDomSink(request: SinkRequest): ConferenceAudioSink {
  return takeConferenceSink(request)
}

/** Фиксированная служебная строка чата (не речь ведущей). */
export function conferenceSinkCreatedText(device: string, owner: string): string {
  return `техническое: у ${device || 'участника'} закончились заготовленные аудиоэлементы, создан новый (дорожка от ${owner || 'неизвестного участника'})`
}

function createDomSink(): ConferenceAudioSink & { prime: () => void } {
  let audio = document.createElement('audio') as HTMLAudioElement & { playsInline: boolean }
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
      audio.addEventListener?.('error', () => diag('звук', '<audio> конференции: ошибка', { code: audio.error?.code ?? null }), { once: true })
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
      if (!(stream instanceof MediaStream)) return
      audio = recreate(audio, stream) as typeof audio
    },
    release() {
      active.delete(sink)
      audio.pause()
      audio.srcObject = null
      if (pool.length < poolLimit) pool.push(sink)
      else audio.remove()
    },
    playback() {
      const stream = audio.srcObject
      const track = stream instanceof MediaStream ? stream.getAudioTracks()[0] : undefined
      return {
        muted: audio.muted,
        paused: audio.paused,
        volume: audio.volume,
        readyState: audio.readyState,
        track: track ? `${track.readyState}/${track.muted ? 'muted' : 'live'}` : 'none',
      }
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
