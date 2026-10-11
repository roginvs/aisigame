import type { ConferenceHandle, ConferenceTile } from './media.ts'
import { fetchJitsiConfig, websocketUrlForBase } from './jitsiConfig.ts'
import type { ConferenceMessage } from './messages.ts'
import { isConferenceMessage } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'
import { createMicMixer, type MicMixer } from './audioMix.ts'
import { nextCameraDeviceId } from './camera.ts'
import { createSpeakerActivity } from './speakerActivity.ts'
import { createConferenceAudioOutput } from './conferenceAudio.ts'

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
  private closed = false

  constructor(conference: JitsiConference, endpointEvent: string, dataChannelEvent?: string) {
    this.conference = conference
    conference.on(endpointEvent, (participant: unknown, data: unknown) => {
      const senderId = endpointSenderId(participant)
      if (senderId && isConferenceMessage(data)) {
        for (const handler of this.handlers) handler(data, senderId)
      }
    })
    if (dataChannelEvent) conference.on(dataChannelEvent, () => this.flush())
  }

  send(message: ConferenceMessage): void {
    if (this.closed) return
    if (message.type === 'snapshot') {
      this.pending = this.pending.filter((item) => item.type !== 'snapshot')
    } else if (message.type === 'hello') {
      this.pending = this.pending.filter(
        (item) => item.type !== 'hello' || item.clientId !== message.clientId,
      )
    }
    this.pending.push(message)
    this.flush()
  }

  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.closed = true
    window.clearTimeout(this.retryTimer)
    this.retryTimer = 0
    this.pending = []
    this.handlers.clear()
  }

  private flush(): void {
    if (this.closed || this.pending.length === 0) return
    window.clearTimeout(this.retryTimer)
    this.retryTimer = 0
    try {
      while (this.pending.length > 0) {
        this.conference.sendEndpointMessage('', this.pending[0])
        this.pending.shift()
      }
    } catch {
      // CONFERENCE_JOINED приходит раньше готовности BridgeChannel. Не роняем
      // сессию: сохраняем порядок сообщений и повторяем после открытия канала.
      this.retryTimer = window.setTimeout(() => this.flush(), 250)
    }
  }
}

function endpointSenderId(participant: unknown): string {
  if (typeof participant === 'string') return participant
  if (!participant || typeof participant !== 'object') return ''
  const getId = (participant as JitsiParticipant).getId
  if (typeof getId !== 'function') return ''
  const id = getId.call(participant)
  return typeof id === 'string' ? id : ''
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
  const JitsiMeetJS = window.JitsiMeetJS
  if (!JitsiMeetJS) throw new Error('JitsiMeetJS не найден')

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
  let cameraOn = false
  let cameraDeviceId: string | null = null
  const hostTracks: JitsiTrack[] = []
  const remoteNames = new Map<string, string>()
  const remoteVideo = new Map<string, JitsiTrack>()
  const remoteAudio = new Map<string, JitsiTrack>()
  const videoBindings = new Map<string, HTMLVideoElement>()
  const conferenceAudio = createConferenceAudioOutput()
  let modelMixer: MicMixer | null = null
  let modelInputParticipantIds: Set<string> | null = null
  let modelInputParticipantSignature = '*'
  const tileListeners = new Set<(tiles: ConferenceTile[]) => void>()
  const localId = () => conference.myUserId() || 'local'
  let botHandle: ConferenceHandle | null = null
  const speakerActivity = createSpeakerActivity(() => emitTiles())

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
    const stream = track.getOriginalStream?.()
    if (!stream) return
    conferenceAudio.attach(id, stream)
    syncModelMixer()
  }

  function dropRemoteAudio(id: string): void {
    conferenceAudio.remove(id)
    remoteAudio.delete(id)
    speakerActivity.clear(id)
    syncModelMixer()
  }

  function syncModelMixer(): void {
    if (!modelMixer) return
    const allows = (id: string) => modelInputParticipantIds === null || modelInputParticipantIds.has(id)
    modelMixer.setLocalMic(allows(localId()) ? localMicMedia : null)
    modelMixer.setRemoteStreams(
      [...remoteAudio.entries()]
        .filter(([id]) => (!botHandle || id !== botHandle.localParticipantId()) && allows(id))
        .map(([, track]) => track.getOriginalStream?.() ?? null)
        .filter((stream): stream is MediaStream => stream !== null),
    )
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
    if (input.bot) return
    const jitsiTrack = track as JitsiTrack
    if (jitsiTrack.isLocal()) return
    const userId = jitsiTrack.getParticipantId?.()
    if (!userId) return
    if (jitsiTrack.getType() === 'video') {
      remoteVideo.set(userId, jitsiTrack)
      if (remoteNames.has(userId)) attachVideo(userId)
    } else if (jitsiTrack.getType() === 'audio') {
      remoteAudio.set(userId, jitsiTrack)
      if (remoteNames.has(userId)) ensureRemoteAudio(userId, jitsiTrack)
    }
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
      hostTracks.push(...tracks)
      for (const track of tracks) await conference.addTrack(track)
    },
    async setMicLive(live: boolean) {
      if (live) {
        if (!localAudio) {
          const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['audio'] })
          localAudio = tracks[0] ?? null
          if (!localAudio) throw new Error('Микрофон недоступен')
          localMicMedia = localAudio.getOriginalStream?.() ?? null
          await conference.addTrack(localAudio)
        }
        await Promise.resolve(localAudio.unmute())
        micLive = true
      } else if (localAudio) {
        await Promise.resolve(localAudio.mute())
        micLive = false
      } else {
        micLive = false
      }
      syncModelMixer()
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
    setModelInputParticipants(participantIds) {
      const signature = participantIds === null ? '*' : [...new Set(participantIds)].sort().join('|')
      if (signature === modelInputParticipantSignature) return
      modelInputParticipantSignature = signature
      modelInputParticipantIds = participantIds === null ? null : new Set(participantIds)
      syncModelMixer()
    },
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
      const currentDeviceId =
        cameraDeviceId ?? localVideo.getOriginalStream?.().getVideoTracks()[0]?.getSettings().deviceId ?? null
      const deviceId = nextCameraDeviceId(devices, currentDeviceId)
      if (!deviceId || deviceId === currentDeviceId) return
      const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['video'], cameraDeviceId: deviceId })
      const nextVideo = tracks[0] ?? null
      if (!nextVideo) throw new Error('Следующая камера недоступна')
      const previousVideo = localVideo
      const element = videoBindings.get(localId())
      try {
        await conference.replaceTrack(previousVideo, nextVideo)
        if (element) previousVideo.detach(element)
        localVideo = nextVideo
        cameraDeviceId = deviceId
        attachVideo(localId())
        previousVideo.dispose()
        emitTiles()
      } catch (error) {
        nextVideo.dispose()
        throw error
      }
    },
    micLive: () => micLive,
    cameraOn: () => cameraOn,
    subscribeTiles(handler) {
      tileListeners.add(handler)
      emitTiles()
      return () => tileListeners.delete(handler)
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
      botHandle?.dispose()
      botHandle = null
      transport.close()
      modelMixer?.dispose()
      modelMixer = null
      speakerActivity.dispose()
      conferenceAudio.dispose()
      tileListeners.clear()
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
        displayName: 'Ведущая',
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
