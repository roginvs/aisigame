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
      localParticipantId: media.localParticipantId,
      subscribeTiles: media.subscribeTiles,
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
  })
}
