import { diag } from '../debug/diag.ts'
import { reopenAudioOutputs } from '../audio/beep.ts'
import { gameSoundsRetryDelayMs } from './gameSoundsRetry.ts'
import {
  HOST_JITSI_NAME,
  SOUNDS_JITSI_NAME,
  isHostJitsiParticipant,
  type ServiceJitsiIds,
  resolveServiceIds,
  modelHearsParticipant,
  type ConferenceHandle,
  type ConferenceTile,
} from './media.ts'
import { fetchJitsiConfig, websocketUrlForBase } from './jitsiConfig.ts'
import type { ConferenceMessage } from './messages.ts'
import { isConferenceMessage } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'
import { createHearWindow } from './hearWindow.ts'
import { hearWindowSampleMs, modelLevelsUpdateMs } from '../options.ts'
import { displayLevel, resetModelLevels, setModelLevels } from './modelLevels.ts'
import { createMicMixer, type MicMixer, type MixerRemote } from './audioMix.ts'
import { cameraFacing, isMobileCameraDevice, nextCameraDeviceId, shouldMirrorVideo, switchFacingCamera, type CameraFacing } from './camera.ts'
import { createSpeakerActivity } from './speakerActivity.ts'
import { conferenceAudioStream, createConferenceAudioOutput } from './conferenceAudio.ts'
import { compressMic, compressMicEligible, type MicCompression } from './micCompression.ts'
import { createSpeechLevels } from './speechLevel.ts'
import { PACK_CHANNEL_HIGH_WATER_BYTES, PACK_CHANNEL_LOW_WATER_BYTES } from './chunks.ts'
import { jitsiVideoLive, mediaStreamTrackFromJitsi, micTrackIsDead } from './micTrack.ts'
import { pushTrace } from '../debug/trace.ts'

type JitsiMeetJS = {
  init: (options: unknown) => void
  setLogLevel: (level: number) => void
  logLevels?: { WARN?: number; ERROR?: number }
  events?: {
    connection?: {
      CONNECTION_ESTABLISHED?: string
      CONNECTION_FAILED?: string
      CONNECTION_DISCONNECTED?: string
    }
    conference?: {
      CONFERENCE_JOINED?: string
      CONFERENCE_FAILED?: string
      DATA_CHANNEL_OPENED?: string
      ENDPOINT_MESSAGE_RECEIVED?: string
      TRACK_ADDED?: string
      TRACK_REMOVED?: string
      USER_JOINED?: string
      USER_LEFT?: string
      DISPLAY_NAME_CHANGED?: string
      TRACK_AUDIO_LEVEL_CHANGED?: string
      TRACK_MUTE_CHANGED?: string
    }
    track?: {
      TRACK_OWNER_SET?: string
    }
  }
  JitsiConnection: new (appId: string | null, token: string | null, options: unknown) => JitsiConnection
  createLocalTracks: (options: { devices: string[]; cameraDeviceId?: string; facingMode?: 'user' | 'environment' }) => Promise<JitsiTrack[]>
  createLocalTracksFromMediaStreams: (streams: { stream: MediaStream; videoType?: string; mediaType?: string }[]) => Promise<JitsiTrack[]>
}

type JitsiConnection = {
  connect: () => void
  disconnect: () => void
  addEventListener: (event: string, handler: (payload?: unknown) => void) => void
  initJitsiConference: (room: string, options: unknown) => JitsiConference
}

type JitsiParticipant = {
  getId?: () => string
  getDisplayName?: () => string
  getTracks?: () => JitsiTrack[]
  isHidden?: () => boolean
}

type JitsiConference = {
  join: () => void
  leave: () => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
  setDisplayName: (name: string) => void
  addTrack: (track: JitsiTrack) => Promise<void>
  removeTrack: (track: JitsiTrack) => Promise<void>
  replaceTrack: (oldTrack: JitsiTrack, newTrack: JitsiTrack) => Promise<void>
  sendEndpointMessage: (to: string, payload: unknown) => void
  myUserId: () => string
  participants?: Map<string, JitsiParticipant>
}

type JitsiTrack = {
  dispose: () => void
  getType: () => string
  isLocal: () => boolean
  isMuted?: () => boolean
  mute: () => Promise<void> | void
  unmute: () => Promise<void> | void
  attach: (element: HTMLElement) => void
  detach: (element: HTMLElement) => void
  getParticipantId?: () => string
  getOriginalStream?: () => MediaStream
  getTrack?: () => MediaStreamTrack
  addEventListener?: (event: string, handler: (...args: unknown[]) => void) => void
  removeEventListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    JitsiMeetJS?: JitsiMeetJS
  }
}

let jitsiInited = false

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Не удалось загрузить lib-jitsi-meet'))
    document.head.append(script)
  })
}

function connectionEvents(api: JitsiMeetJS) {
  return {
    established: api.events?.connection?.CONNECTION_ESTABLISHED ?? 'connection.connectionEstablished',
    failed: api.events?.connection?.CONNECTION_FAILED ?? 'connection.connectionFailed',
    disconnected: api.events?.connection?.CONNECTION_DISCONNECTED ?? 'connection.connectionDisconnected',
  }
}

function conferenceEvents(api: JitsiMeetJS) {
  return {
    joined: api.events?.conference?.CONFERENCE_JOINED ?? 'conference.joined',
    failed: api.events?.conference?.CONFERENCE_FAILED ?? 'conference.failed',
    dataChannelOpened: api.events?.conference?.DATA_CHANNEL_OPENED ?? 'conference.dataChannelOpened',
    endpointMessage: api.events?.conference?.ENDPOINT_MESSAGE_RECEIVED ?? 'conference.endpoint_message_received',
    trackAdded: api.events?.conference?.TRACK_ADDED ?? 'conference.trackAdded',
    trackRemoved: api.events?.conference?.TRACK_REMOVED ?? 'conference.trackRemoved',
    userJoined: api.events?.conference?.USER_JOINED ?? 'conference.userJoined',
    userLeft: api.events?.conference?.USER_LEFT ?? 'conference.userLeft',
    displayName: api.events?.conference?.DISPLAY_NAME_CHANGED ?? 'conference.displayNameChanged',
    audioLevel:
      api.events?.conference?.TRACK_AUDIO_LEVEL_CHANGED ?? 'conference.audioLevelsChanged',
    trackMute: api.events?.conference?.TRACK_MUTE_CHANGED ?? 'conference.trackMuteChanged',
    // SSRC rewriting: lib переназначает удалённую дорожку другому участнику без add/remove.
    trackOwnerSet: api.events?.track?.TRACK_OWNER_SET ?? 'track.owner_set',
  }
}

export class JitsiMessageTransport implements ConferenceTransport {
  private handlers = new Set<(message: ConferenceMessage, senderId: string) => void>()
  private conference: JitsiConference
  private pending: ConferenceMessage[] = []
  private retryTimer = 0
  private drainTimer = 0
  private closed = false
  private dataChannel: RTCDataChannel | null = null
  private drainListener: (() => void) | null = null

  constructor(conference: JitsiConference, endpointEvent: string, dataChannelEvent?: string) {
    this.conference = conference
    conference.on(endpointEvent, (participant: unknown, data: unknown) => {
      const senderId = endpointSenderId(participant)
      if (senderId && isConferenceMessage(data)) {
        for (const handler of this.handlers) handler(data, senderId)
      }
    })
    if (dataChannelEvent) {
      conference.on(dataChannelEvent, () => {
        this.dataChannel = null
        this.flush()
      })
    }
  }

  send(message: ConferenceMessage): void {
    if (this.closed) return
    if (message.type === 'snapshot') {
      // Снимок важнее кусков пакета: иначе окно CHUNK_WINDOW забивает канал,
      // joiner 10 с не видит presence и пишет «Мастер-игрок отключился».
      this.pending = this.pending.filter((item) =>
        (item.type !== 'snapshot' && item.type !== 'partialUpdate') || item.authorityToken !== message.authorityToken,
      )
      this.pending.unshift(message)
    } else if (message.type === 'partialUpdate') {
      // Дифы идут в исходном порядке, сразу после ожидающего полного статуса;
      // куски пакета с забитым bufferedAmount не задерживают presence/ходы.
      const lastState = this.pending.findLastIndex((item) => item.type === 'snapshot' || item.type === 'partialUpdate')
      this.pending.splice(lastState + 1, 0, message)
    } else if (message.type === 'hello') {
      this.pending = this.pending.filter(
        (item) => item.type !== 'hello' || item.clientId !== message.clientId,
      )
      this.pending.push(message)
    } else {
      this.pending.push(message)
    }
    this.flush()
  }

  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.closed = true
    this.clearRetryTimer()
    this.clearDrainWait()
    this.pending = []
    this.handlers.clear()
    this.dataChannel = null
  }

  private flush(): void {
    if (this.closed || this.pending.length === 0) return
    this.clearRetryTimer()
    try {
      while (this.pending.length > 0) {
        const next = this.pending[0]!
        // Снимки/hello пропускаем даже при полном буфере; тормозим только куски.
        if (next.type === 'packChunk' && this.packSendBlocked()) {
          this.armBufferedDrain()
          return
        }
        this.conference.sendEndpointMessage('', next)
        this.pending.shift()
      }
      this.clearDrainWait()
    } catch {
      // CONFERENCE_JOINED приходит раньше готовности BridgeChannel. Не роняем
      // сессию: сохраняем порядок сообщений и повторяем после открытия канала.
      this.retryTimer = window.setTimeout(() => this.flush(), 250)
    }
  }

  private packSendBlocked(): boolean {
    const channel = this.resolveDataChannel()
    if (!channel) return false
    return channel.bufferedAmount > PACK_CHANNEL_HIGH_WATER_BYTES
  }

  private resolveDataChannel(): RTCDataChannel | null {
    if (this.dataChannel && this.dataChannel.readyState !== 'closed') return this.dataChannel
    this.dataChannel = findBridgeDataChannel(this.conference)
    if (this.dataChannel) {
      try {
        this.dataChannel.bufferedAmountLowThreshold = PACK_CHANNEL_LOW_WATER_BYTES
      } catch {
        // Некоторые обёртки не дают писать порог — остаётся опрос по таймеру.
      }
    }
    return this.dataChannel
  }

  private armBufferedDrain(): void {
    if (this.closed) return
    const channel = this.resolveDataChannel()
    if (channel && !this.drainListener) {
      this.drainListener = () => this.flush()
      channel.addEventListener('bufferedamountlow', this.drainListener)
    }
    if (!this.drainTimer) {
      this.drainTimer = window.setTimeout(() => {
        this.drainTimer = 0
        this.flush()
      }, 100)
    }
  }

  private clearRetryTimer(): void {
    window.clearTimeout(this.retryTimer)
    this.retryTimer = 0
  }

  private clearDrainWait(): void {
    window.clearTimeout(this.drainTimer)
    this.drainTimer = 0
    if (this.drainListener && this.dataChannel) {
      this.dataChannel.removeEventListener('bufferedamountlow', this.drainListener)
    }
    this.drainListener = null
  }
}

function isRtcDataChannel(value: unknown): value is RTCDataChannel {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as RTCDataChannel).bufferedAmount === 'number' &&
      typeof (value as RTCDataChannel).readyState === 'string' &&
      typeof (value as RTCDataChannel).addEventListener === 'function',
  )
}

/** Достаём RTCDataChannel Bridge Channel из внутренностей lib-jitsi-meet, если доступен. */
export function findBridgeDataChannel(conference: unknown): RTCDataChannel | null {
  if (!conference || typeof conference !== 'object') return null
  const rtc = (conference as { rtc?: unknown }).rtc
  if (!rtc || typeof rtc !== 'object') return null

  const holders: unknown[] = [
    (rtc as { _channel?: unknown })._channel,
    (rtc as { channel?: unknown }).channel,
  ]
  for (const holder of holders) {
    if (isRtcDataChannel(holder)) return holder
    if (holder && typeof holder === 'object') {
      const inner =
        (holder as { _channel?: unknown })._channel ?? (holder as { channel?: unknown }).channel
      if (isRtcDataChannel(inner)) return inner
    }
  }

  const pc =
    (rtc as { peerconnection?: RTCPeerConnection }).peerconnection ??
    (rtc as { _peerConnection?: RTCPeerConnection })._peerConnection
  const getChannels = pc
    ? (pc as unknown as { getDataChannels?: () => RTCDataChannel[] }).getDataChannels
    : undefined
  const list = typeof getChannels === 'function' ? getChannels.call(pc) : null
  const open = list?.find((channel) => channel.readyState === 'open')
  return open ?? null
}

function endpointSenderId(participant: unknown): string {
  if (typeof participant === 'string') return participant
  if (!participant || typeof participant !== 'object') return ''
  const getId = (participant as JitsiParticipant).getId
  if (typeof getId !== 'function') return ''
  const id = getId.call(participant)
  return typeof id === 'string' ? id : ''
}

export function visibleJitsiParticipants<
  T extends {
    getId?: () => string
    getDisplayName?: () => string
    isHidden?: () => boolean
  },
>(participants: ReadonlyMap<string, T> | undefined): Array<{ id: string; name: string; participant: T }> {
  if (!participants) return []
  const visible: Array<{ id: string; name: string; participant: T }> = []
  for (const [fallbackId, participant] of participants) {
    if (participant.isHidden?.()) continue
    const id = participant.getId?.() || fallbackId
    if (!id) continue
    visible.push({ id, name: participant.getDisplayName?.() || id, participant })
  }
  return visible
}

export async function connectJitsiConference(input: {
  jitsiBase: string
  roomName: string
  displayName: string
  bot?: boolean
  createHostParticipant?: boolean
  /** Мастер: участник «Звуки игры» не подключился или отпал. */
  onSoundsLost?: (message: string) => void
  /** После успешного повторного подключения «Звуков игры». */
  onSoundsRestored?: () => void
  onError?: (message: string) => void
}): Promise<ConferenceHandle> {
  const base = input.jitsiBase.replace(/\/+$/, '')
  await loadScript(`${base}/libs/lib-jitsi-meet.min.js`)
  const hosts = await fetchJitsiConfig(base)
  const api = window.JitsiMeetJS
  if (!api) throw new Error('JitsiMeetJS не найден')
  const JitsiMeetJS: JitsiMeetJS = api

  // INFO/LOG у lib-jitsi-meet очень многословны (в частности, на каждом
  // endpoint message) и при открытых DevTools могут заметно тормозить мастера.
  // Ошибки приложения остаются в нашем debug trace, от Jitsi оставляем WARN+.
  JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels?.WARN ?? 4)
  if (!jitsiInited) {
    JitsiMeetJS.init({
      disableAudioLevels: false,
      audioLevelsInterval: 200,
      disableThirdPartyRequests: true,
    })
    jitsiInited = true
  }

  const connEvents = connectionEvents(JitsiMeetJS)
  const confEvents = conferenceEvents(JitsiMeetJS)
  const serviceUrl = websocketUrlForBase(base)
  const connection = new JitsiMeetJS.JitsiConnection(null, null, {
    hosts,
    serviceUrl,
    clientNode: 'http://jitsi.org/jitsimeet',
    p2p: { enabled: false },
  })
  let disposed = false

  const ready = new Promise<JitsiConference>((resolve, reject) => {
    let settled = false
    const fail = (message: string) => {
      if (disposed) return
      if (settled) {
        input.onError?.(message)
        return
      }
      settled = true
      reject(new Error(message))
    }
    const ok = (conference: JitsiConference) => {
      if (settled) return
      settled = true
      resolve(conference)
    }

    connection.addEventListener(connEvents.failed, () => fail('Соединение Jitsi не удалось'))
    connection.addEventListener(connEvents.disconnected, () => fail('Соединение Jitsi прервалось'))
    connection.addEventListener(connEvents.established, () => {
      const conference = connection.initJitsiConference(input.roomName, {
        p2p: { enabled: false },
        startAudioMuted: true,
        startVideoMuted: true,
      })
      conference.setDisplayName(input.displayName)
      conference.on(confEvents.joined, () => ok(conference))
      conference.on(confEvents.failed, (error?: unknown) => {
        const detail = typeof error === 'string' ? error : ''
        fail(detail ? `Комната Jitsi недоступна: ${detail}` : 'Комната Jitsi недоступна')
      })
      conference.join()
    })
    connection.connect()
  })

  const conference = await ready
  const transport = new JitsiMessageTransport(
    conference,
    confEvents.endpointMessage,
    confEvents.dataChannelOpened,
  )

  let localAudio: JitsiTrack | null = null
  let localVideo: JitsiTrack | null = null
  let localMicMedia: MediaStream | null = null
  let micLive = false
  /** Компрессор опубликованного микрофона: сырую дорожку не трогаем, в комнату уходит сжатая. */
  let micCompress: MicCompression | null = null
  let micCompressTrack: JitsiTrack | null = null
  /** Пользователь хочет микрофон включённым — даже если дорожка оборвалась на телефоне. */
  let wantMicLive = false
  let recoveringMic = false
  let localMicEndedUnsub: (() => void) | null = null
  let cameraOn = false
  let cameraDeviceId: string | null = null
  /** Что просили у телефона; если браузер не сообщает facingMode — ориентир для зеркала. */
  let requestedFacing: CameraFacing | null = null
  const hostTracks: JitsiTrack[] = []
  const remoteNames = new Map<string, string>()
  const remoteVideo = new Map<string, JitsiTrack>()
  /**
   * Все удалённые аудиодорожки. Владельца не храним: при SSRC rewriting Jitsi
   * переназначает дорожку другому участнику, поэтому id берём у дорожки в момент синка.
   */
  const remoteAudioTracks = new Map<JitsiTrack, { key: string; unsubOwner: () => void }>()
  let remoteTrackSeq = 0
  const videoBindings = new Map<string, HTMLVideoElement>()
  const conferenceAudio = createConferenceAudioOutput()
  let modelMixer: MicMixer | null = null
  /** `null` — модель слышит всех; иначе только этот Jitsi participant id. */
  let modelHearOnlyId: string | null | false = null
  let lastFallbackFocus = ''
  /** Последний уровень Jitsi по участнику (TRACK_AUDIO_LEVEL_CHANGED) — для сравнения с клоном в миксе. */
  const jitsiLevels = new Map<string, number>()
  /** Ключ источника микса → participant id на последнем синке. */
  const mixerOwners = new Map<string, string>()
  let hearWindow: ReturnType<typeof createHearWindow> | null = null
  let hearTimer: number | null = null

  function closeHearWindow(): void {
    if (hearTimer !== null) window.clearInterval(hearTimer)
    hearTimer = null
    if (!hearWindow) return
    pushTrace('note', 'Модель: окно слушания (уровни микса)', hearWindow.summary(performance.now()))
    hearWindow = null
  }

  function sampleHearWindow(): void {
    if (!modelMixer || !hearWindow) return
    const samples = modelMixer.levels().map((item) => {
      const participantId = item.key === 'local' ? localId() : mixerOwners.get(item.key) ?? ''
      return { ...item, participantId, jitsi: participantId ? jitsiLevels.get(participantId) ?? 0 : null }
    })
    const bus = modelMixer.busLevel()
    samples.push({ key: 'bus', participantId: 'модель', gain: 1, rms: bus.rms, peak: bus.peak, postRms: bus.rms, jitsi: null })
    for (const key of hearWindow.add(samples)) {
      if (key === 'bus' || key === 'local') {
        pushTrace('note', 'Модель: Jitsi слышит речь, а в миксе тишина', { key })
        continue
      }
      pushTrace('note', 'Модель: немой клон дорожки — пересоздаём', { key, participantId: mixerOwners.get(key) ?? '' })
      modelMixer.reattach(key)
      syncModelMixer()
    }
  }

  let levelsTimer: number | null = null
  /** Уровни после микшера → индикатор мастера (игрокам не рассылаются). */
  function publishModelLevels(): void {
    if (!modelMixer) return
    const byParticipant: Record<string, number> = {}
    for (const item of modelMixer.levels()) {
      const id = item.key === 'local' ? localId() : mixerOwners.get(item.key) ?? ''
      if (!id) continue
      byParticipant[id] = Math.max(byParticipant[id] ?? 0, displayLevel(item.postRms))
    }
    setModelLevels({ total: displayLevel(modelMixer.busLevel().rms), byParticipant })
  }

  function openHearWindow(focus: string | false | null): void {
    closeHearWindow()
    if (typeof focus !== 'string' || !modelMixer) return
    hearWindow = createHearWindow(focus, performance.now())
    hearTimer = window.setInterval(sampleHearWindow, hearWindowSampleMs)
  }
  const tileListeners = new Set<(tiles: ConferenceTile[]) => void>()
  const hostSpeakingListeners = new Set<(speaking: boolean) => void>()
  /** Реплики людей: дорожка ≥1 с говорила (уровень Jitsi) — напоминание «ответ без кнопки». */
  const speechActivityListeners = new Set<(participantId: string) => void>()
  const speechLevels = createSpeechLevels((participantId) => {
    for (const listener of speechActivityListeners) listener(participantId)
  })
  let lastHostSpeaking = false
  const localId = () => conference.myUserId() || 'local'
  let botHandle: ConferenceHandle | null = null
  let soundsHandle: ConferenceHandle | null = null
  let soundsStream: MediaStream | null = null
  let soundsRetryAttempt = 0
  let soundsRetryTimer: number | null = null
  let soundsConnecting = false
  const speakerActivity = createSpeakerActivity(() => emitTiles())

  /** Игрок: id служебных участников из снимка мастера (`setServiceIds`). */
  let snapshotServiceIds: ServiceJitsiIds = { host: null, sounds: null }
  const serviceIdListeners = new Set<(ids: ServiceJitsiIds) => void>()
  let lastServiceIds = ''

  function botParticipantId(): string | null {
    return botHandle?.localParticipantId() ?? null
  }

  /** Свои соединения мастера важнее снимка; у игрока своих нет — только снимок. Имя не смотрим. */
  function serviceIds(): ServiceJitsiIds {
    return resolveServiceIds(
      { host: botParticipantId(), sounds: soundsHandle?.localParticipantId() ?? null },
      snapshotServiceIds,
    )
  }

  function notifyServiceIds(): void {
    const ids = serviceIds()
    const key = `${ids.host ?? ''}|${ids.sounds ?? ''}`
    if (key === lastServiceIds) return
    lastServiceIds = key
    for (const listener of serviceIdListeners) listener(ids)
  }

  function isHostRemote(id: string): boolean {
    return isHostJitsiParticipant(id, serviceIds().host)
  }

  /** Служебные участники: не плитки, не «кто-то говорит». */
  function isServiceRemote(id: string): boolean {
    return !modelHearsParticipant(id, serviceIds())
  }

  function hostSpeakingNow(): boolean {
    const hostId = serviceIds().host
    return Boolean(hostId) && speakerActivity.has(hostId!)
  }

  function anyoneSpeaking(): boolean {
    if (speakerActivity.has(localId())) return true
    for (const id of remoteNames.keys()) {
      if (isServiceRemote(id)) continue
      if (speakerActivity.has(id)) return true
    }
    return false
  }

  function localFacing(): CameraFacing | null {
    if (!localVideo) return requestedFacing
    const settings = localVideo.getOriginalStream?.().getVideoTracks()[0]?.getSettings() as { facingMode?: string } | undefined
    const jitsi = (localVideo as { getCameraFacingMode?: () => string | undefined }).getCameraFacingMode?.()
    return cameraFacing(settings, jitsi, requestedFacing)
  }

  function emitTiles(): void {
    const tiles: ConferenceTile[] = [
      {
        id: localId(),
        name: input.displayName,
        isLocal: true,
        micLive,
        cameraOn,
        mirror: shouldMirrorVideo(true, localFacing()),
        speaking: speakerActivity.has(localId()),
      },
    ]
    for (const [id, name] of remoteNames) {
      if (id === localId()) continue
      if (isServiceRemote(id)) continue
      tiles.push({
        id,
        name,
        isLocal: false,
        mirror: false,
        micLive: remoteAudioOf(id).some((track) => !track.isMuted?.()),
        cameraOn: jitsiVideoLive(remoteVideo.get(id)),
        speaking: speakerActivity.has(id),
      })
    }
    for (const listener of tileListeners) listener(tiles)
    const speaking = hostSpeakingNow()
    if (speaking !== lastHostSpeaking) {
      lastHostSpeaking = speaking
      for (const listener of hostSpeakingListeners) listener(speaking)
    }
  }

  function attachVideo(id: string): void {
    const element = videoBindings.get(id)
    const track = id === localId() ? localVideo : remoteVideo.get(id)
    if (!element || !track || !jitsiVideoLive(track)) return
    track.attach(element)
    void element.play().catch(() => undefined)
  }

  function trackOwner(track: JitsiTrack): string {
    return track.getParticipantId?.() ?? ''
  }

  function remoteAudioOf(id: string): JitsiTrack[] {
    return [...remoteAudioTracks.keys()].filter((track) => trackOwner(track) === id)
  }

  function ensureRemoteAudio(track: JitsiTrack): void {
    const entry = remoteAudioTracks.get(track)
    if (!entry) return
    const owner = trackOwner(track)
    // Свою «Ведущую» мастер тоже слушает из комнаты, как все (в микс модели она не идёт — syncModelMixer).
    const stream = conferenceAudioStream(track)
    // Скрытых/ещё не пришедших участников не проигрываем (как раньше); userJoined дозовёт.
    if (!stream || !remoteNames.has(owner)) {
      syncModelMixer()
      return
    }
    // <audio> по ключу дорожки: смена владельца не рвёт воспроизведение.
    if (isHostRemote(owner)) diag('ведущая-звук', 'дорожка «Ведущей» из комнаты → <audio>', { track: entry.key, participantId: owner })
    conferenceAudio.attach(entry.key, stream, remoteNames.get(owner) ?? '')
    syncModelMixer()
  }

  function rememberRemoteTrack(jitsiTrack: JitsiTrack): void {
    if (input.bot || jitsiTrack.isLocal()) return
    const userId = jitsiTrack.getParticipantId?.()
    if (!userId) return
    if (jitsiTrack.getType() === 'video') {
      remoteVideo.set(userId, jitsiTrack)
      if (remoteNames.has(userId)) attachVideo(userId)
    } else if (jitsiTrack.getType() === 'audio') {
      if (!remoteAudioTracks.has(jitsiTrack)) {
        const key = `t${++remoteTrackSeq}`
        const onOwner = () => {
          pushTrace('note', 'Удалённая аудиодорожка сменила владельца', {
            track: key, participantId: trackOwner(jitsiTrack),
          })
          ensureRemoteAudio(jitsiTrack)
          emitTiles()
        }
        jitsiTrack.addEventListener?.(confEvents.trackOwnerSet, onOwner)
        remoteAudioTracks.set(jitsiTrack, {
          key,
          unsubOwner: () => jitsiTrack.removeEventListener?.(confEvents.trackOwnerSet, onOwner),
        })
      }
      ensureRemoteAudio(jitsiTrack)
    }
  }

  function dropRemoteAudioTrack(track: JitsiTrack): void {
    const entry = remoteAudioTracks.get(track)
    if (!entry) return
    if (isHostRemote(trackOwner(track))) diag('ведущая-звук', 'дорожка «Ведущей» из комнаты снята', { track: entry.key })
    entry.unsubOwner()
    conferenceAudio.remove(entry.key)
    remoteAudioTracks.delete(track)
  }

  function dropRemoteAudio(id: string): void {
    for (const track of remoteAudioOf(id)) dropRemoteAudioTrack(track)
    speakerActivity.clear(id)
    syncModelMixer()
  }

  function syncModelMixer(): void {
    if (!modelMixer) return
    const ids = serviceIds()
    // В микс — только включённый микрофон: muted remotes не кладём, иначе clone()
    // с enabled=false после unmute остаётся мёртвым, а <audio> уже играет.
    // Выбор/ответ сужают микс до одного участника; HTML playback людей не трогаем.
    // Все живые удалённые дорожки подключены постоянно; фокус/mute — только гейн.
    // Владелец — по track.getParticipantId() сейчас, не сохранённый при trackAdded.
    const remotes: MixerRemote[] = []
    for (const [track, entry] of remoteAudioTracks) {
      const owner = trackOwner(track)
      if (!owner) continue
      // Ни «Ведущую», ни эффекты модель не слышит (узнаём только по id, имя — подпись):
      // иначе она слышит своё же чтение и controller считает это перебиванием (TALKED_OVER).
      if (!modelHearsParticipant(owner, ids)) continue
      const stream = conferenceAudioStream(track)
      if (!stream) continue
      const muted = Boolean(track.isMuted?.())
      remotes.push({ key: entry.key, participantId: owner, stream, muted })
      mixerOwners.set(`remote-${entry.key}`, owner)
    }
    const result = modelMixer.update({
      remotes,
      local: { participantId: localId(), stream: localMicMedia, live: micLive },
      focus: modelHearOnlyId,
    })
    const focus = modelHearOnlyId
    const fallbackKey = typeof focus === 'string' ? focus : ''
    if (result.fallback && fallbackKey !== lastFallbackFocus) {
      pushTrace('note', 'Модель: у фокуса нет живой дорожки, слушаем всех', {
        participantId: fallbackKey,
        owners: remotes.map((item) => `${item.participantId}${item.muted ? '(muted)' : ''}`).join(','),
      })
    }
    lastFallbackFocus = result.fallback ? fallbackKey : ''
  }

  function stopWatchingLocalMic(): void {
    localMicEndedUnsub?.()
    localMicEndedUnsub = null
  }

  function watchLocalMic(track: JitsiTrack): void {
    stopWatchingLocalMic()
    const media = mediaStreamTrackFromJitsi(track)
    if (!media) return
    const onEnded = () => {
      if (disposed || !wantMicLive) return
      pushTrace('note', 'Локальный микрофон оборвался, переподключаем')
      void recoverLocalMic()
    }
    media.addEventListener('ended', onEnded)
    localMicEndedUnsub = () => media.removeEventListener('ended', onEnded)
  }

  async function dropLocalAudioTrack(): Promise<void> {
    stopWatchingLocalMic()
    micCompress?.stop()
    micCompress = null
    const compressed = micCompressTrack
    micCompressTrack = null
    const previous = localAudio
    localAudio = null
    localMicMedia = null
    if (compressed) {
      try {
        await conference.removeTrack(compressed)
      } catch {
        // Обработанная дорожка могла уже уйти из комнаты.
      }
      try {
        compressed.dispose()
      } catch {
        // ignore
      }
    }
    if (!previous) return
    try {
      await conference.removeTrack(previous)
    } catch {
      // Дорожка уже могла уйти из комнаты вместе с ended.
    }
    try {
      previous.dispose()
    } catch {
      // ignore
    }
  }

  async function publishFreshLocalMic(): Promise<void> {
    const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['audio'] })
    const next = tracks[0] ?? null
    if (!next) throw new Error('Микрофон недоступен')
    for (const extra of tracks.slice(1)) extra.dispose()
    localAudio = next
    // Тот же объект, что опубликован в комнату, и та же функция, что для чужих дорожек.
    // Свою дорожку Jitsi обратно не присылает (trackAdded только у других).
    // В модель и на уровень кнопки — та же обработанная дорожка, что уходит в комнату:
    // модель слышит ровно то, что слышат люди.
    watchLocalMic(next)
    const published = await publishProcessedMic(next)
    localMicMedia = conferenceAudioStream(published)
    await conference.addTrack(published)
    await Promise.resolve(published.unmute())
    reopenAudioOutputs()
    micLive = true
    syncModelMixer()
    conferenceAudio.resume()
    emitTiles()
  }

  /**
   * Компрессор опубликованного микрофона: сырую дорожку оставляем без обработки
   * (микс модели, уровни), в комнату уходит сжатая копия. Не получилось — сырая, как раньше.
   */
  async function publishProcessedMic(raw: JitsiTrack): Promise<JitsiTrack> {
    micCompress?.stop()
    micCompressTrack = null
    const browserTrack = mediaStreamTrackFromJitsi(raw)
    if (!browserTrack || micTrackIsDead(browserTrack) || !compressMicEligible()) return raw
    const handled = compressMic(browserTrack)
    if (!handled) return raw
    browserTrack.addEventListener?.('ended', () => {
      // Устройство сменилось или дорожка умерла: обработка осталась молчащей — пересобираем микрофон.
      const active = handled.stream.getAudioTracks()[0]
      if (!active || active.readyState !== 'live') void recoverLocalMic()
    }, { once: true })
    try {
      const created = await JitsiMeetJS.createLocalTracksFromMediaStreams([
        { stream: handled.stream, mediaType: 'audio' },
      ])
      const compressed = created[0] ?? null
      for (const extra of created.slice(1)) extra.dispose()
      if (compressed && !micTrackIsDead(mediaStreamTrackFromJitsi(compressed))) {
        micCompress = handled
        micCompressTrack = compressed
        pushTrace('note', 'Микрофон конференции публикуется с компрессором (тихих выравниваем)')
        return compressed
      }
      compressed?.dispose()
      handled.stop()
      pushTrace('note', 'Обработанная дорожка микрофона не ожила — публикуют сырую')
      return raw
    } catch (error) {
      handled.stop()
      pushTrace('note', `Компрессор микрофона не подключён: ${error instanceof Error ? error.message : String(error)}`)
      return raw
    }
  }

  async function recoverLocalMic(): Promise<void> {
    if (disposed || recoveringMic || !wantMicLive) return
    recoveringMic = true
    micLive = false
    emitTiles()
    try {
      await dropLocalAudioTrack()
      await publishFreshLocalMic()
      pushTrace('note', 'Микрофон переподключён после обрыва дорожки')
    } catch (error) {
      micLive = false
      wantMicLive = false
      emitTiles()
      pushTrace('note', 'Не удалось переподключить микрофон', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      recoveringMic = false
    }
  }

  conference.on(confEvents.userJoined, (id: unknown, participant: unknown) => {
    const userId = String(id)
    const person = participant as JitsiParticipant | undefined
    if (person?.isHidden?.()) return
    remoteNames.set(userId, person?.getDisplayName?.() || userId)
    for (const audio of remoteAudioOf(userId)) ensureRemoteAudio(audio)
    attachVideo(userId)
    emitTiles()
  })

  conference.on(confEvents.userLeft, (id: unknown) => {
    const userId = String(id)
    remoteNames.delete(userId)
    const video = remoteVideo.get(userId)
    const el = videoBindings.get(userId)
    if (video && el) video.detach(el)
    remoteVideo.delete(userId)
    dropRemoteAudio(userId)
    speakerActivity.clear(userId)
    emitTiles()
  })

  conference.on(confEvents.displayName, (id: unknown, name: unknown) => {
    const userId = String(id)
    if (remoteNames.has(userId) && typeof name === 'string') {
      remoteNames.set(userId, name)
      emitTiles()
    }
  })

  conference.on(confEvents.trackAdded, (track: unknown) => {
    rememberRemoteTrack(track as JitsiTrack)
    emitTiles()
  })

  conference.on(confEvents.trackRemoved, (track: unknown) => {
    if (input.bot) return
    const jitsiTrack = track as JitsiTrack
    if (jitsiTrack.isLocal()) return
    const userId = jitsiTrack.getParticipantId?.()
    if (!userId) return
    if (jitsiTrack.getType() === 'video') {
      const el = videoBindings.get(userId)
      if (el) jitsiTrack.detach(el)
      remoteVideo.delete(userId)
    } else if (jitsiTrack.getType() === 'audio') {
      // Запоздалое «удалено» старой дорожки после replace/recover не должно
      // выкинуть уже пришедшую новую дорожку того же участника.
      dropRemoteAudioTrack(jitsiTrack)
      speakerActivity.clear(userId)
      syncModelMixer()
    }
    emitTiles()
  })

  conference.on(confEvents.audioLevel, (id: unknown, level: unknown) => {
    if (input.bot || typeof id !== 'string' || typeof level !== 'number') return
    jitsiLevels.set(id, level)
    speakerActivity.note(id, level)
    speechLevels.note(id, level)
  })

  conference.on(confEvents.trackMute, (track: unknown) => {
    if (input.bot) return
    const jitsiTrack = track as JitsiTrack
    const userId = jitsiTrack.isLocal() ? localId() : jitsiTrack.getParticipantId?.()
    if (userId && jitsiTrack.isMuted?.()) speakerActivity.clear(userId)
    // Mute видео оставляет <video> на последнем кадре — снимаем дорожку и даём UI placeholder.
    if (userId && jitsiTrack.getType() === 'video') {
      const el = videoBindings.get(userId)
      if (jitsiTrack.isMuted?.()) {
        if (el) jitsiTrack.detach(el)
      } else {
        attachVideo(userId)
      }
    }
    // Mute/unmute аудио: пересобрать клон в миксе модели (fingerprint с enabled).
    if (jitsiTrack.getType() === 'audio') {
      const muted = Boolean(jitsiTrack.isMuted?.())
      if (userId && !jitsiTrack.isLocal()) {
        pushTrace('note', muted ? 'Удалённый микрофон выключен' : 'Удалённый микрофон включён', {
          participantId: userId,
        })
      }
      syncModelMixer()
    }
    emitTiles()
  })

  if (!input.bot) {
    for (const current of visibleJitsiParticipants(conference.participants)) {
      remoteNames.set(current.id, current.name)
      for (const track of current.participant.getTracks?.() ?? []) rememberRemoteTrack(track)
    }
  }
  emitTiles()

  const handle: ConferenceHandle = {
    transport,
    ...(input.createHostParticipant ? {
      async publishSoundsStream(stream: MediaStream) {
        soundsStream = stream
        if (!soundsHandle) {
          // Участника нет — попытки идут; поток опубликуем при успехе. App показывает ошибку.
          input.onSoundsLost?.('не подключён')
          scheduleSoundsRetry('ожидание участника')
          return
        }
        try {
          await soundsHandle.publishHostStream(stream)
        } catch (error) {
          dropSounds(error instanceof Error ? error.message : String(error))
        }
      },
    } : {}),
    async publishHostStream(stream: MediaStream) {
      if (input.createHostParticipant) {
        if (!botHandle) throw new Error('Подключение ведущей к Jitsi ещё не готово')
        await botHandle.publishHostStream(stream)
        return
      }
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length !== 1) throw new Error('В потоке ведущей должна быть ровно одна аудиодорожка')
      const hostStream = new MediaStream([audioTracks[0]!])
      const tracks = await JitsiMeetJS.createLocalTracksFromMediaStreams([
        { stream: hostStream, mediaType: 'audio' },
      ])
      const next = tracks[0]
      if (!next) throw new Error('Не удалось создать дорожку ведущей')
      for (const extra of tracks.slice(1)) extra.dispose()
      const previous = hostTracks[0] ?? null
      try {
        if (previous) {
          // Повторный ontrack/attachHostOutput не должен копить вторую «Ведущую».
          await conference.replaceTrack(previous, next)
          previous.dispose()
          hostTracks[0] = next
        } else {
          await conference.addTrack(next)
          hostTracks.push(next)
        }
      } catch (error) {
        next.dispose()
        throw error
      }
    },
    async setMicLive(live: boolean) {
      wantMicLive = live
      const toggle = async (track: JitsiTrack | null, op: 'mute' | 'unmute'): Promise<void> => {
        if (!track) return
        try {
          await Promise.resolve(op === 'mute' ? track.mute() : track.unmute())
        } catch {
          // Глушение одной из дорожек не рвёт попытку: ошибки логируем и идём дальше.
        }
      }
      if (live) {
        // На телефоне ОС иногда убивает MediaStreamTrack: mute/unmute уже не помогает.
        if (localAudio && micTrackIsDead(mediaStreamTrackFromJitsi(localAudio))) {
          await recoverLocalMic()
          return
        }
        if (!localAudio) {
          await publishFreshLocalMic()
          return
        }
        await toggle(localAudio, 'unmute')
        await toggle(micCompressTrack, 'unmute')
        micLive = true
        watchLocalMic(localAudio)
      } else {
        // Сырую дорожку device-gate не видит, поэтому глушим и обработанную копию в комнате тоже.
        // (Мьютим обе, даже если сырой не было: при live=true восстановить нечего.)
        await toggle(localAudio, 'mute')
        await toggle(micCompressTrack, 'mute')
        micLive = false
      }
      syncModelMixer()
      conferenceAudio.resume()
      emitTiles()
    },
    localMicStream: () => localMicMedia,
    modelInputStream: () => {
      if (!modelMixer) {
        levelsTimer = window.setInterval(publishModelLevels, modelLevelsUpdateMs)
        modelMixer = createMicMixer((event) => {
          pushTrace('note', 'Модель: источник микса', {
            ...event,
            participantId: event.key === 'local' ? localId() : mixerOwners.get(event.key) ?? '',
          })
        })
        syncModelMixer()
      }
      return modelMixer.outputStream()
    },
    modelMeter: () => modelMixer?.meter() ?? null,
    setModelHearOnly(participantId) {
      const changed = participantId !== modelHearOnlyId
      modelHearOnlyId = participantId
      syncModelMixer()
      if (changed) {
        pushTrace('note', 'Модель: фокус микшера', { focus: participantId })
        openHearWindow(participantId)
      }
    },
    anyoneSpeaking,
    localParticipantId: localId,
    serviceIds,
    setServiceIds(ids) {
      if (ids.host === snapshotServiceIds.host && ids.sounds === snapshotServiceIds.sounds) return
      snapshotServiceIds = { host: ids.host, sounds: ids.sounds }
      pushTrace('note', 'Служебные участники из снимка', { host: ids.host ?? '', sounds: ids.sounds ?? '' })
      syncModelMixer()
      emitTiles()
      notifyServiceIds()
    },
    subscribeServiceIds(handler) {
      serviceIdListeners.add(handler)
      return () => serviceIdListeners.delete(handler)
    },
    async setCameraOn(on: boolean) {
      if (on) {
        if (!localVideo) {
          const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['video'] })
          localVideo = tracks[0] ?? null
          if (!localVideo) throw new Error('Камера недоступна')
          await conference.addTrack(localVideo)
          cameraDeviceId = localVideo.getOriginalStream?.().getVideoTracks()[0]?.getSettings().deviceId ?? null
        }
        cameraOn = true
        attachVideo(localId())
      } else if (localVideo) {
        const el = videoBindings.get(localId())
        if (el) localVideo.detach(el)
        await conference.removeTrack(localVideo)
        localVideo.dispose()
        localVideo = null
        cameraOn = false
      } else {
        cameraOn = false
      }
      emitTiles()
    },
    async cycleCamera() {
      if (!localVideo || !cameraOn) return
      if (isMobileCameraDevice(typeof navigator === 'undefined' ? undefined : navigator)) {
        // Телефон не даёт держать две камеры: отпускаем старую, берём по facingMode, при ошибке — назад.
        const previous = localVideo
        const current = localFacing() ?? 'user'
        const element = videoBindings.get(localId())
        const result = await switchFacingCamera<JitsiTrack>({
          current,
          release: async () => {
            if (element) previous.detach(element)
            await conference.removeTrack(previous)
            previous.dispose()
            localVideo = null
          },
          open: async (facing) => {
            const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['video'], facingMode: facing })
            const track = tracks[0]
            if (!track) throw new Error('Камера недоступна')
            return track
          },
          install: async (track, facing) => {
            await conference.addTrack(track)
            localVideo = track
            requestedFacing = facing
            cameraDeviceId = track.getOriginalStream?.().getVideoTracks()[0]?.getSettings().deviceId ?? null
          },
          dispose: (track) => track.dispose(),
        }).catch((error: unknown) => {
          cameraOn = false
          emitTiles()
          throw error instanceof Error ? error : new Error('Камера недоступна')
        })
        attachVideo(localId())
        emitTiles()
        if (result.restored) {
          pushTrace('note', 'Другая камера не открылась, вернули прежнюю', { error: String(result.error) })
          throw new Error('Другая камера не открылась, оставили прежнюю')
        }
        return
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId)
      if (cameras.length <= 1) return
      let tryFrom =
        cameraDeviceId ?? localVideo.getOriginalStream?.().getVideoTracks()[0]?.getSettings().deviceId ?? null
      let lastError: unknown = null
      for (let attempt = 0; attempt < cameras.length - 1; attempt += 1) {
        const deviceId = nextCameraDeviceId(devices, tryFrom)
        if (!deviceId || deviceId === tryFrom) break
        tryFrom = deviceId
        let nextVideo: JitsiTrack | null = null
        try {
          const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['video'], cameraDeviceId: deviceId })
          nextVideo = tracks[0] ?? null
          if (!nextVideo) throw new Error('Следующая камера недоступна')
          const previousVideo = localVideo
          const element = videoBindings.get(localId())
          await conference.replaceTrack(previousVideo, nextVideo)
          localVideo = nextVideo
          nextVideo = null
          cameraDeviceId = deviceId
          try {
            if (element) previousVideo.detach(element)
            attachVideo(localId())
          } catch {
            // Камера в комнате уже новая; плитка подцепится при следующем bind.
          }
          previousVideo.dispose()
          emitTiles()
          return
        } catch (error) {
          nextVideo?.dispose()
          lastError = error
          pushTrace('note', 'Камера не переключилась, пробуем следующую', {
            deviceId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Следующая камера недоступна')
    },
    micLive: () => micLive,
    cameraOn: () => cameraOn,
    subscribeTiles(handler) {
      tileListeners.add(handler)
      emitTiles()
      return () => tileListeners.delete(handler)
    },
    subscribeHostSpeaking(handler) {
      hostSpeakingListeners.add(handler)
      handler(lastHostSpeaking)
      return () => hostSpeakingListeners.delete(handler)
    },
    subscribeSpeechActivity(handler) {
      speechActivityListeners.add(handler)
      return () => speechActivityListeners.delete(handler)
    },
    bindVideo(participantId, element) {
      const previous = videoBindings.get(participantId)
      const track = participantId === localId() ? localVideo : remoteVideo.get(participantId)
      if (previous && track) track.detach(previous)
      if (!element) {
        videoBindings.delete(participantId)
        return
      }
      videoBindings.set(participantId, element)
      attachVideo(participantId)
    },
    dispose() {
      if (disposed) return
      disposed = true
      wantMicLive = false
      stopWatchingLocalMic()
      botHandle?.dispose()
      botHandle = null
      if (soundsRetryTimer) window.clearTimeout(soundsRetryTimer)
      soundsRetryTimer = null
      soundsStream = null
      soundsHandle?.dispose()
      soundsHandle = null
      transport.close()
      closeHearWindow()
      if (levelsTimer !== null) window.clearInterval(levelsTimer)
      resetModelLevels()
      modelMixer?.dispose()
      modelMixer = null
      speakerActivity.dispose()
      conferenceAudio.dispose()
      tileListeners.clear()
      hostSpeakingListeners.clear()
      speechLevels.dispose()
      serviceIdListeners.clear()
      for (const [id, track] of remoteVideo) {
        const el = videoBindings.get(id)
        if (el) track.detach(el)
      }
      for (const track of [...remoteAudioTracks.keys()]) dropRemoteAudioTrack(track)
      if (localVideo) {
        const el = videoBindings.get(localId())
        if (el) localVideo.detach(el)
        void conference.removeTrack(localVideo).finally(() => localVideo?.dispose())
      }
      if (localAudio) {
        void conference.removeTrack(localAudio).finally(() => localAudio?.dispose())
      }
      for (const track of hostTracks) {
        void conference.removeTrack(track).finally(() => track.dispose())
      }
      videoBindings.clear()
      remoteVideo.clear()
      remoteNames.clear()
      conference.leave()
      connection.disconnect()
    },
  }

  if (input.createHostParticipant) {
    try {
      botHandle = await connectJitsiConference({
        jitsiBase: input.jitsiBase,
        roomName: input.roomName,
        displayName: HOST_JITSI_NAME,
        bot: true,
        onError: input.onError,
      })
      emitTiles()
      notifyServiceIds()
    } catch (error) {
      handle.dispose()
      throw error
    }
  }

  async function connectSoundsBot(): Promise<boolean> {
    if (disposed || soundsHandle || soundsConnecting) return Boolean(soundsHandle)
    soundsConnecting = true
    try {
      const next = await connectJitsiConference({
        jitsiBase: input.jitsiBase,
        roomName: input.roomName,
        displayName: SOUNDS_JITSI_NAME,
        bot: true,
        onError: (message) => {
          pushTrace('note', `«Звуки игры»: ${message}`)
          dropSounds(message)
        },
      })
      if (disposed) {
        next.dispose()
        return false
      }
      // Не плодим второго: если успели подключить параллельно — лишний отпускаем.
      if (soundsHandle) {
        next.dispose()
        return true
      }
      soundsHandle = next
      notifyServiceIds()
      soundsRetryAttempt = 0
      if (soundsRetryTimer) {
        window.clearTimeout(soundsRetryTimer)
        soundsRetryTimer = null
      }
      emitTiles()
      if (soundsStream) {
        try {
          await next.publishHostStream(soundsStream)
        } catch (error) {
          dropSounds(error instanceof Error ? error.message : String(error))
          return false
        }
      }
      input.onSoundsRestored?.()
      return true
    } catch (error) {
      pushTrace('note', 'Участник «Звуки игры» не подключился', { error: String(error) })
      return false
    } finally {
      soundsConnecting = false
    }
  }

  function dropSounds(reason: string): void {
    if (disposed) return
    soundsHandle?.dispose()
    soundsHandle = null
    notifyServiceIds()
    input.onSoundsLost?.(reason)
    // Повторяем, пока жива конференция.
    scheduleSoundsRetry(reason)
  }

  function scheduleSoundsRetry(reason: string): void {
    if (disposed || soundsHandle || soundsRetryTimer || soundsConnecting) return
    const delay = gameSoundsRetryDelayMs(soundsRetryAttempt)
    soundsRetryAttempt += 1
    pushTrace('note', 'Повтор «Звуки игры»', { reason, delayMs: delay, attempt: soundsRetryAttempt })
    soundsRetryTimer = window.setTimeout(() => {
      soundsRetryTimer = null
      void connectSoundsBot().then((ok) => {
        if (!ok) scheduleSoundsRetry('повтор не удался')
      })
    }, delay)
  }

  if (input.createHostParticipant) {
    const ok = await connectSoundsBot()
    if (!ok) {
      input.onSoundsLost?.('не подключился')
      scheduleSoundsRetry('не подключился')
    }
  }

  return handle
}
