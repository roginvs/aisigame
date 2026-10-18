import { reopenAudioOutputs } from '../audio/beep.ts'
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

/**
 * Скрытый участник мастера: в его дорожку идут все звуковые эффекты игры,
 * чтобы у всех (и у мастера) они звучали тем же путём и громкостью, что и ведущая.
 * Не плитка, не игрок, не в миксе модели.
 */
export const SOUNDS_JITSI_NAME = 'Звуки игры'

export const gameSoundsErrorText = 'Ошибка: звук игры не проигрывается — участник «Звуки игры» не подключился.'

export { gameSoundsRestoredText } from './gameSoundsRetry.ts'

/** Id служебных участников мастера в Jitsi. Узнаём их только по id, имя — лишь подпись. */
export type ServiceJitsiIds = { host: string | null; sounds: string | null }

export function isSoundsJitsiParticipant(id: string, soundsParticipantId: string | null): boolean {
  return Boolean(soundsParticipantId) && id === soundsParticipantId
}

export function isHostJitsiParticipant(id: string, botParticipantId: string | null): boolean {
  return Boolean(botParticipantId) && id === botParticipantId
}

/**
 * Итоговые id служебных участников: свои соединения мастера важнее снимка
 * (снимок мог ещё не догнать переподключение «Звуков игры»); у игрока своих нет — берём снимок.
 */
export function resolveServiceIds(own: ServiceJitsiIds, fromSnapshot: ServiceJitsiIds): ServiceJitsiIds {
  return { host: own.host ?? fromSnapshot.host, sounds: own.sounds ?? fromSnapshot.sounds }
}

/** Кого кладём в микс, который слышит модель: только людей — не «Ведущую» (её же голос = ложное перебивание чтения) и не эффекты. */
export function modelHearsParticipant(id: string, ids: ServiceJitsiIds): boolean {
  return !isHostJitsiParticipant(id, ids.host) && !isSoundsJitsiParticipant(id, ids.sounds)
}

export type ConferenceMedia = {
  publishHostStream: (stream: MediaStream) => Promise<void>
  /** Только мастер Jitsi: опубликовать поток эффектов скрытым участником «Звуки игры». */
  publishSoundsStream?: (stream: MediaStream) => Promise<void>
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
  /**
   * Id «Ведущей» и «Звуков игры» в Jitsi. У мастера — его собственные соединения;
   * у игрока — из полученного снимка (`setServiceIds`).
   */
  serviceIds: () => ServiceJitsiIds
  /** Игрок: id служебных участников из снимка мастера. У мастера свои соединения важнее. */
  setServiceIds: (ids: ServiceJitsiIds) => void
  /** Мастер: id «Ведущей»/«Звуков игры» сменились (подключились или переподключились). */
  subscribeServiceIds: (handler: (ids: ServiceJitsiIds) => void) => () => void
  subscribeTiles: (handler: (tiles: ConferenceTile[]) => void) => () => void
  /** Уровень речи бота «Ведущая» в Jitsi — для пульсации портрета, не плитки. */
  subscribeHostSpeaking: (handler: (speaking: boolean) => void) => () => void
  /** Дорожка участника начала реплику (≥1 с речи по уровню): напоминание об ответе без кнопки. */
  subscribeSpeechActivity: (handler: (participantId: string) => void) => () => void
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
        reopenAudioOutputs()
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
    serviceIds: () => ({ host: null, sounds: null }),
    setServiceIds() {},
    subscribeServiceIds: () => () => {},
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
    subscribeSpeechActivity() {
      return () => {}
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
