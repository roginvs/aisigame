import { audioEnvironment, diag } from '../debug/diag.ts'
import { primeConferencePlayback, refreshConferenceSinks, setConferenceElementRecreate } from '../conference/conferenceAudio.ts'
import { buzzerBeepMs } from '../options.ts'

let audioContext: AudioContext | null = null

/**
 * Куда идут звуковые эффекты игры.
 * - `local` — в динамик (одиночная игра, broadcast-конференция);
 * - `stream` — мастер Jitsi: в MediaStream скрытого участника «Звуки игры», слышно всем из конференции;
 * - `remote` — joiner Jitsi: локально не играем, эффект придёт из конференции;
 * - `broken` — мастер Jitsi, участник «Звуки игры» не подключился или отпал: молчим, локального запасного пути нет.
 * Тайминги игры от этого не зависят: длительности заданы константами, а не событием `ended`.
 */
export type GameSoundRoute = 'local' | 'stream' | 'remote' | 'broken'
let soundRoute: GameSoundRoute = 'local'
let soundSink: MediaStreamAudioDestinationNode | null = null

export function gameSoundRoute(): GameSoundRoute {
  return soundRoute
}

/** Поток для участника «Звуки игры»; маршрут переключается в `stream`. */
export function gameSoundStream(): MediaStream {
  const ctx = ensureContext()
  if (!soundSink || soundSink.context !== ctx) soundSink = ctx.createMediaStreamDestination()
  soundRoute = 'stream'
  return soundSink.stream
}

export function setGameSoundRoute(route: 'local' | 'remote' | 'broken'): void {
  soundRoute = route
}

/** Сбой «Звуков игры»: `true` только при первом сбое (ошибку показать один раз); снова — после `local`/нового потока. */
export function markGameSoundsBroken(): boolean {
  if (soundRoute === 'broken') return false
  soundRoute = 'broken'
  return true
}

/** Выход эффекта; `null` — локально не играть. */
function soundOutput(ctx: AudioContext): AudioNode | null {
  if (soundRoute === 'remote' || soundRoute === 'broken') return null
  if (soundRoute === 'stream') return soundSink && soundSink.context === ctx ? soundSink : null
  return gameOutput(ctx)
}

const pipCount = 3
const pipSeconds = 0.085
const pipGapSeconds = 0.07

export function unlockAudio(): void {
  const ctx = ensureContext()
  void ctx.resume()
  gameOutput(ctx)
  void bus?.element?.play().catch(() => undefined)
  primeConferencePlayback()
}

/**
 * Android Chrome: пока открыт микрофон, Chrome в режиме разговора, и качелька громкости
 * управляет потоком «звонок». Звук WebRTC (участники Jitsi) идёт туда, а выход AudioContext,
 * открытый до микрофона, остаётся на потоке «медиа» — второй ползунок, тихо и не той кнопкой.
 * Поэтому на Android весь звук игры (ведущая у мастера, клипы вопросов, пи-пи-пи) идёт
 * через MediaStream в скрытый `<audio>`, как дорожки конференции, а после открытия микрофона
 * этот элемент и дорожки конференции переподключаются — их вывод создаётся заново уже в режиме разговора.
 */
type OutputBus = { ctx: AudioContext; input: GainNode; element: HTMLAudioElement | null; stream: MediaStream | null }
let bus: OutputBus | null = null

export function routesGameAudioThroughElement(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Android/i.test(userAgent)
}

/** Общий выход звука игры: вместо `ctx.destination`. */
export function gameOutput(ctx: AudioContext = ensureContext()): AudioNode {
  if (!routesGameAudioThroughElement()) return ctx.destination
  if (bus && bus.ctx === ctx) return bus.input
  const input = ctx.createGain()
  let element: HTMLAudioElement | null = null
  let stream: MediaStream | null = null
  if (routesGameAudioThroughElement() && typeof document !== 'undefined' && document.body && typeof ctx.createMediaStreamDestination === 'function') {
    const destination = ctx.createMediaStreamDestination()
    input.connect(destination)
    stream = destination.stream
    element = document.createElement('audio')
    element.autoplay = true
    element.setAttribute('playsinline', 'true')
    element.setAttribute('data-game-audio', '')
    element.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none'
    element.srcObject = stream
    document.body.append(element)
    void element.play().catch((error: unknown) => diag('звук', 'звук игры: play() отклонён', { error: String(error) }))
    diag('звук', 'звук игры через <audio> (Android)', audioEnvironment(ctx))
  } else {
    input.connect(ctx.destination)
  }
  bus = { ctx, input, element, stream }
  return input
}

/**
 * Вызвать сразу после открытия микрофона: заново создать вывод звука игры и дорожек конференции,
 * чтобы на Android он попал в поток «звонок», которым управляет качелька.
 */
export function reopenAudioOutputs(): void {
  diag('звук', 'микрофон открыт', { ...audioEnvironment(bus?.ctx ?? null), rerouting: routesGameAudioThroughElement(), reopeners: reopeners.size })
  if (!routesGameAudioThroughElement()) return
  if (bus?.element && bus.stream) bus.element = recreateStreamElement(bus.element, bus.stream)
  for (const reopen of reopeners) reopen()
  refreshConferenceSinks()
  diag('звук', 'выводы пересозданы после микрофона (Android → «звонок»)', audioEnvironment(bus?.ctx ?? null))
}

const reopeners = new Set<() => void>()
setConferenceElementRecreate((old, stream) => recreateStreamElement(old, stream) as typeof old)

/** Другие выходы с `srcObject` (голос ведущей OpenAI у мастера): пересоздать после микрофона. */
export function onAudioOutputsReopen(reopen: () => void): () => void {
  reopeners.add(reopen)
  return () => { reopeners.delete(reopen) }
}

/**
 * Новый `<audio>` вместо старого с тем же потоком. Переприсвоить `srcObject` мало:
 * на телефоне голос ведущей так и остался на «медиа» (4b58587). Новый элемент — новый вывод.
 */
export function recreateStreamElement(old: HTMLAudioElement, stream: MediaStream): HTMLAudioElement {
  const next = document.createElement('audio')
  next.autoplay = true
  next.setAttribute('playsinline', 'true')
  for (const name of old.getAttributeNames?.() ?? []) if (name.startsWith('data-') || name === 'style') next.setAttribute(name, old.getAttribute(name) ?? '')
  next.muted = old.muted
  next.volume = old.volume
  old.pause()
  old.srcObject = null
  old.remove?.()
  next.srcObject = stream
  if (old.isConnected !== false && document.body) document.body.append(next)
  void next.play().catch((error: unknown) => diag('звук', 'пересозданный <audio>: play() отклонён', { error: String(error) }))
  diag('звук', 'пересоздан <audio>', { kind: next.getAttributeNames?.().filter((name) => name.startsWith('data-')).join(',') ?? '', muted: next.muted })
  return next
}

/** Контекст, который открывает жест старта. Индикатор вопроса берёт его же, чтобы не остаться suspended. */
export function gameAudioContext(): AudioContext {
  return ensureContext()
}

/**
 * Пи-пи-пи через Web Audio, не через элемент <audio>.
 * Пауза клипа вопроса этот сигнал не останавливает: осциллятор идёт в выход контекста, не в анализатор клипа.
 */
export function playTimeoutBeep(): void {
  const ctx = ensureContext()
  void ctx.resume()
  const output = soundOutput(ctx)
  const duration = buzzerBeepMs / 1000
  const origin = ctx.currentTime
  for (let index = 0; output && index < pipCount; index += 1) {
    const at = origin + index * (pipSeconds + pipGapSeconds)
    const until = at + pipSeconds
    if (until > origin + duration + 0.0001) break
    pip(ctx, at, until, output)
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('aisigame-beep'))
  }
}

function ensureContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext()
  return audioContext
}

function pip(ctx: AudioContext, at: number, until: number, output: AudioNode): void {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'square'
  oscillator.frequency.value = 1400
  oscillator.connect(gain)
  gain.connect(output)
  gain.gain.setValueAtTime(0.08, at)
  gain.gain.linearRampToValueAtTime(0.0001, until)
  oscillator.start(at)
  oscillator.stop(until)
}

const publicBuffers = new Map<string, Promise<AudioBuffer | null>>()

function publicUrl(path: string): string {
  const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/'
  return `${base}${path.replace(/^\//, '')}`
}

/** Скачивает и декодирует звук из public/ один раз; ошибки глушатся — без звука игра идёт дальше. */
export function preloadPublicSound(path: string): Promise<AudioBuffer | null> {
  const cached = publicBuffers.get(path)
  if (cached) return cached
  const loading = (async () => {
    try {
      const response = await fetch(publicUrl(path))
      if (!response.ok) return null
      return await ensureContext().decodeAudioData(await response.arrayBuffer())
    } catch {
      return null
    }
  })()
  publicBuffers.set(path, loading)
  return loading
}

/** Короткий звук из public/ через Web Audio (тот же контекст, что и пи-пи-пи). */
export async function playPublicSound(path: string): Promise<boolean> {
  const ctx = ensureContext()
  const output = soundOutput(ctx)
  if (output) {
    const buffer = await preloadPublicSound(path)
    if (!buffer) return false
    void ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(output)
    source.start()
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('aisigame-special-sound', { detail: path }))
  }
  return true
}

export const catMeowSound = 'sounds/meow.wav'
export const auctionDingSound = 'sounds/auction.wav'

export function playCatMeow(): Promise<boolean> {
  return playPublicSound(catMeowSound)
}

export function playAuctionDing(): Promise<boolean> {
  return playPublicSound(auctionDingSound)
}

export function resetPublicSoundsForTest(): void {
  publicBuffers.clear()
  soundRoute = 'local'
  soundSink = null
}
