import {
  HOST_JITSI_NAME,
  isHostJitsiParticipant,
  type ConferenceHandle,
  type ConferenceTile,
} from './media.ts'
import { fetchJitsiConfig, websocketUrlForBase } from './jitsiConfig.ts'
import type { ConferenceMessage } from './messages.ts'
import { isConferenceMessage } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'
import { createMicMixer, streamsForModelHear, type MicMixer } from './audioMix.ts'
import { nextCameraDeviceId } from './camera.ts'
import { createSpeakerActivity } from './speakerActivity.ts'
import { conferenceAudioStream, createConferenceAudioOutput } from './conferenceAudio.ts'
import { PACK_CHANNEL_HIGH_WATER_BYTES, PACK_CHANNEL_LOW_WATER_BYTES } from './chunks.ts'
import { mediaStreamTrackFromJitsi, micTrackIsDead } from './micTrack.ts'
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
  }
  JitsiConnection: new (appId: string | null, token: string | null, options: unknown) => JitsiConnection
  createLocalTracks: (options: { devices: string[]; cameraDeviceId?: string }) => Promise<JitsiTrack[]>
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
      this.pending = this.pending.filter((item) => item.type !== 'snapshot')
      this.pending.unshift(message)
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
  /** Пользователь хочет микрофон включённым — даже если дорожка оборвалась на телефоне. */
  let wantMicLive = false
  let recoveringMic = false
  let localMicEndedUnsub: (() => void) | null = null
  let cameraOn = false
  let cameraDeviceId: string | null = null
  const hostTracks: JitsiTrack[] = []
  const remoteNames = new Map<string, string>()
  const remoteVideo = new Map<string, JitsiTrack>()
  const remoteAudio = new Map<string, JitsiTrack>()
  const videoBindings = new Map<string, HTMLVideoElement>()
  const conferenceAudio = createConferenceAudioOutput()
  let modelMixer: MicMixer | null = null
  /** `null` — модель слышит всех; иначе только этот Jitsi participant id. */
  let modelHearOnlyId: string | null = null
  const tileListeners = new Set<(tiles: ConferenceTile[]) => void>()
  const hostSpeakingListeners = new Set<(speaking: boolean) => void>()
  let lastHostSpeaking = false
  const localId = () => conference.myUserId() || 'local'
  let botHandle: ConferenceHandle | null = null
  const speakerActivity = createSpeakerActivity(() => emitTiles())

  function botParticipantId(): string | null {
    return botHandle?.localParticipantId() ?? null
  }

  function isHostRemote(id: string, name?: string): boolean {
    return isHostJitsiParticipant(id, name ?? remoteNames.get(id) ?? '', botParticipantId())
  }

  function hostSpeakingNow(): boolean {
    const botId = botParticipantId()
    if (botId && speakerActivity.has(botId)) return true
    for (const [id, name] of remoteNames) {
      if (isHostJitsiParticipant(id, name, botId) && speakerActivity.has(id)) return true
    }
    return false
  }

  function anyoneSpeaking(): boolean {
    if (speakerActivity.has(localId())) return true
    for (const [id, name] of remoteNames) {
      if (isHostRemote(id, name)) continue
      if (speakerActivity.has(id)) return true
    }
    return false
  }

  function emitTiles(): void {
    const tiles: ConferenceTile[] = [
      {
        id: localId(),
        name: input.displayName,
        isLocal: true,
        micLive,
        cameraOn,
        speaking: speakerActivity.has(localId()),
      },
    ]
    for (const [id, name] of remoteNames) {
      if (id === localId()) continue
      if (isHostRemote(id, name)) continue
      tiles.push({
        id,
        name,
        isLocal: false,
        micLive: Boolean(remoteAudio.get(id) && !remoteAudio.get(id)?.isMuted?.()),
        cameraOn: remoteVideo.has(id),
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
    if (!element || !track) return
    track.attach(element)
    void element.play().catch(() => undefined)
  }

  function ensureRemoteAudio(id: string, track: JitsiTrack): void {
    if (botHandle && id === botHandle.localParticipantId()) return
    const stream = conferenceAudioStream(track)
    if (!stream) return
    conferenceAudio.attach(id, stream)
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
      remoteAudio.set(userId, jitsiTrack)
      if (remoteNames.has(userId)) ensureRemoteAudio(userId, jitsiTrack)
    }
  }

  function dropRemoteAudio(id: string): void {
    conferenceAudio.remove(id)
    remoteAudio.delete(id)
    speakerActivity.clear(id)
    syncModelMixer()
  }

  function syncModelMixer(): void {
    if (!modelMixer) return
    const botId = botParticipantId()
    // В микс — только включённый микрофон: при mute клон раньше продолжал
    // кормить модель, а оригинал без клона подчиняется Jitsi mute/unmute.
    // Выбор/ответ сужают микс до одного участника; HTML playback людей не трогаем.
    const remotes = [...remoteAudio.entries()]
      .filter(([id]) => !botId || id !== botId)
      .flatMap(([id, track]) => {
        const stream = conferenceAudioStream(track)
        return stream ? [{ id, stream }] : []
      })
    const selected = streamsForModelHear({
      remotes,
      localId: localId(),
      localStream: micLive ? localMicMedia : null,
      focusParticipantId: modelHearOnlyId,
    })
    modelMixer.setLocalMic(selected.local)
    modelMixer.setRemoteStreams(selected.remotes)
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
    const previous = localAudio
    localAudio = null
    localMicMedia = null
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
    localMicMedia = next.getOriginalStream?.() ?? null
    watchLocalMic(next)
    await conference.addTrack(next)
    await Promise.resolve(next.unmute())
    micLive = true
    syncModelMixer()
    conferenceAudio.resume()
    emitTiles()
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
    const audio = remoteAudio.get(userId)
    if (audio) ensureRemoteAudio(userId, audio)
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
      dropRemoteAudio(userId)
    }
    emitTiles()
  })

  conference.on(confEvents.audioLevel, (id: unknown, level: unknown) => {
    if (input.bot || typeof id !== 'string' || typeof level !== 'number') return
    speakerActivity.note(id, level)
  })

  conference.on(confEvents.trackMute, (track: unknown) => {
    if (input.bot) return
    const jitsiTrack = track as JitsiTrack
    const userId = jitsiTrack.isLocal() ? localId() : jitsiTrack.getParticipantId?.()
    if (userId && jitsiTrack.isMuted?.()) speakerActivity.clear(userId)
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
        await Promise.resolve(localAudio.unmute())
        micLive = true
        watchLocalMic(localAudio)
      } else if (localAudio) {
        await Promise.resolve(localAudio.mute())
        micLive = false
      } else {
        micLive = false
      }
      syncModelMixer()
      conferenceAudio.resume()
      emitTiles()
    },
    localMicStream: () => localMicMedia,
    modelInputStream: () => {
      if (!modelMixer) {
        modelMixer = createMicMixer()
        syncModelMixer()
      }
      return modelMixer.outputStream()
    },
    setModelHearOnly(participantId) {
      modelHearOnlyId = participantId
      syncModelMixer()
    },
    anyoneSpeaking,
    localParticipantId: localId,
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
      transport.close()
      modelMixer?.dispose()
      modelMixer = null
      speakerActivity.dispose()
      conferenceAudio.dispose()
      tileListeners.clear()
      hostSpeakingListeners.clear()
      for (const [id, track] of remoteVideo) {
        const el = videoBindings.get(id)
        if (el) track.detach(el)
      }
      for (const id of [...remoteAudio.keys()]) dropRemoteAudio(id)
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
    } catch (error) {
      handle.dispose()
      throw error
    }
  }

  return handle
}
