import { gameAudioContext } from '../audio/beep.ts'
import { pushTrace } from '../debug/trace.ts'

type AudioOutputContext = Pick<AudioContext, 'createMediaStreamSource' | 'destination' | 'resume'>

export type ConferenceAudioOutput = {
  attach: (participantId: string, stream: MediaStream) => void
  remove: (participantId: string) => void
  dispose: () => void
}

/**
 * Проигрывает WebRTC-потоки через AudioContext, который разблокирован кликом
 * входа в конференцию. Динамический <audio autoplay> мобильные браузеры блокируют.
 */
export function createConferenceAudioOutput(
  context: AudioOutputContext = gameAudioContext(),
): ConferenceAudioOutput {
  const sources = new Map<string, MediaStreamAudioSourceNode>()

  function remove(participantId: string): void {
    sources.get(participantId)?.disconnect()
    sources.delete(participantId)
  }

  return {
    attach(participantId, stream) {
      if (stream.getAudioTracks().length === 0) return
      remove(participantId)
      const source = context.createMediaStreamSource(stream)
      source.connect(context.destination)
      sources.set(participantId, source)
      void context.resume().catch((error: unknown) => {
        pushTrace('note', 'Не удалось включить звук конференции', {
          participantId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
    remove,
    dispose() {
      for (const source of sources.values()) source.disconnect()
      sources.clear()
    },
  }
}
