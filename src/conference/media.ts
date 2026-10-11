export type ConferenceTile = {
  id: string
  name: string
  isLocal: boolean
  micLive: boolean
  cameraOn: boolean
  speaking: boolean
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
   * Ограничить микс модели одним участником Jitsi; `null` — снова все.
   * HTML/Jitsi playback для людей не трогает.
   */
  setModelHearOnly: (participantId: string | null) => void
  /** Есть ли речь людей в комнате (без дорожки «Ведущей»). */
  anyoneSpeaking: () => boolean
  localParticipantId: () => string
  subscribeTiles: (handler: (tiles: ConferenceTile[]) => void) => () => void
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
  const listeners = new Set<(tiles: ConferenceTile[]) => void>()

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
    bindVideo() {},
    dispose() {
      listeners.clear()
      micStream?.getTracks().forEach((track) => track.stop())
      micStream = null
    },
  }
}
