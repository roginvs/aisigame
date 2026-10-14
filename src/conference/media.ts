/** Display name of the model bot in Jitsi; never shown as a video tile. */
export const HOST_JITSI_NAME = 'Ведущая'

export type ConferenceTile = {
  id: string
  name: string
  isLocal: boolean
  micLive: boolean
  cameraOn: boolean
  speaking: boolean
  /** Зеркалить картинку: только своя фронтальная (или неизвестная своя). */
  mirror?: boolean
}

export function isHostJitsiParticipant(id: string, name: string, botParticipantId: string | null): boolean {
  if (botParticipantId && id === botParticipantId) return true
  return name === HOST_JITSI_NAME
}

export type ConferenceMedia = {
  publishHostStream: (stream: MediaStream) => Promise<void>
  setMicLive: (live: boolean) => Promise<void>
  setCameraOn: (on: boolean) => Promise<void>
  cycleCamera: () => Promise<void>
  micLive: () => boolean
  cameraOn: () => boolean
  localMicStream: () => MediaStream | null
  /** Общий поток локального микрофона и удалённых игроков для ведущей-модели. */
  modelInputStream: () => MediaStream | null
  /**
   * Кого слышит модель: id участника, `null` — все, `false` — никого.
   * HTML/Jitsi playback для людей не трогает.
   */
  setModelHearOnly: (participantId: string | null | false) => void
  /** Отвод выхода микшера модели для индикатора (только Jitsi-мастер). */
  modelMeter?: () => AnalyserNode | null
  /** Есть ли речь людей в комнате (без дорожки «Ведущей»). */
  anyoneSpeaking: () => boolean
  localParticipantId: () => string
  subscribeTiles: (handler: (tiles: ConferenceTile[]) => void) => () => void
  /** Уровень речи бота «Ведущая» в Jitsi — для пульсации портрета, не плитки. */
  subscribeHostSpeaking: (handler: (speaking: boolean) => void) => () => void
  bindVideo: (participantId: string, element: HTMLVideoElement | null) => void
}

export type ConferenceHandle = ConferenceMedia & {
  transport: import('./transport.ts').ConferenceTransport
  dispose: () => void
}

export function createBroadcastMedia(displayName: string): ConferenceMedia & { dispose: () => void } {
  let mic = false
  let camera = false
  let micStream: MediaStream | null = null
  // Индикатор «что слышит модель» в тестовом режиме: модель берёт сам micStream.
  let meterContext: AudioContext | null = null
  let meterNode: AnalyserNode | null = null
  let meterStream: MediaStream | null = null
  const listeners = new Set<(tiles: ConferenceTile[]) => void>()
  const hostSpeakingListeners = new Set<(speaking: boolean) => void>()

  function emit(): void {
    const tiles: ConferenceTile[] = [
      { id: 'local', name: displayName, isLocal: true, micLive: mic, cameraOn: camera, speaking: false },
    ]
    for (const listener of listeners) listener(tiles)
  }

  emit()

  return {
    async publishHostStream() {},
    async setMicLive(live) {
      if (live && !micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      }
      if (micStream) {
        for (const track of micStream.getAudioTracks()) track.enabled = live
      }
      mic = live
      emit()
    },
    async setCameraOn(on) {
      camera = on
      emit()
    },
    async cycleCamera() {},
    micLive: () => mic,
    cameraOn: () => camera,
    localMicStream: () => micStream,
    modelInputStream: () => micStream,
    modelMeter() {
      if (typeof AudioContext === 'undefined') return null
      meterContext ??= new AudioContext()
      if (!meterNode) {
        meterNode = meterContext.createAnalyser()
        meterNode.fftSize = 512
      }
      if (micStream && meterStream !== micStream) {
        meterStream = micStream
        meterContext.createMediaStreamSource(micStream).connect(meterNode)
      }
      return meterNode
    },
    setModelHearOnly() {},
    anyoneSpeaking: () => false,
    localParticipantId: () => 'local',
    subscribeTiles(handler) {
      listeners.add(handler)
      handler([
        { id: 'local', name: displayName, isLocal: true, micLive: mic, cameraOn: camera, speaking: false },
      ])
      return () => listeners.delete(handler)
    },
    subscribeHostSpeaking(handler) {
      hostSpeakingListeners.add(handler)
      handler(false)
      return () => hostSpeakingListeners.delete(handler)
    },
    bindVideo() {},
    dispose() {
      listeners.clear()
      hostSpeakingListeners.clear()
      micStream?.getTracks().forEach((track) => track.stop())
      micStream = null
      void meterContext?.close().catch(() => undefined)
      meterContext = null
      meterNode = null
    },
  }
}
