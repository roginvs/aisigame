import { createBroadcastMedia, type ConferenceHandle } from './media.ts'
import { BroadcastChannelTransport } from './transport.ts'

export async function createConferenceTransport(input: {
  roomId: string
  useBroadcast: boolean
  jitsiBase?: string
  displayName?: string
  /** Только мастер публикует отдельного участника с голосом модели. */
  publishHost?: boolean
  onError?: (message: string) => void
  onSoundsLost?: (message: string) => void
  onSoundsRestored?: () => void
}): Promise<ConferenceHandle> {
  const displayName = input.displayName ?? 'Игрок'
  if (input.useBroadcast) {
    const transport = new BroadcastChannelTransport(input.roomId)
    const media = createBroadcastMedia(displayName)
    return {
      transport,
      publishHostStream: media.publishHostStream,
      setMicLive: media.setMicLive,
      setCameraOn: media.setCameraOn,
      cycleCamera: media.cycleCamera,
      micLive: media.micLive,
      cameraOn: media.cameraOn,
      localMicStream: media.localMicStream,
      modelInputStream: media.modelInputStream,
      setModelHearOnly: media.setModelHearOnly,
      modelMeter: media.modelMeter,
      anyoneSpeaking: media.anyoneSpeaking,
      localParticipantId: media.localParticipantId,
      serviceIds: media.serviceIds,
      setServiceIds: media.setServiceIds,
      subscribeServiceIds: media.subscribeServiceIds,
      subscribeTiles: media.subscribeTiles,
      subscribeHostSpeaking: media.subscribeHostSpeaking,
    subscribeSpeechActivity: media.subscribeSpeechActivity,
      bindVideo: media.bindVideo,
      dispose: () => {
        media.dispose()
        transport.close()
      },
    }
  }
  const { connectJitsiConference } = await import('./jitsiRoom.ts')
  return connectJitsiConference({
    jitsiBase: input.jitsiBase ?? '',
    roomName: input.roomId,
    displayName,
    createHostParticipant: input.publishHost === true,
    onError: input.onError,
    onSoundsLost: input.onSoundsLost,
    onSoundsRestored: input.onSoundsRestored,
  })
}
