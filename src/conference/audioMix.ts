export type MicMixer = {
  setRemoteStreams: (streams: MediaStream[]) => void
  setLocalMic: (stream: MediaStream | null) => void
  outputStream: () => MediaStream | null
  dispose: () => void
}

type MixerSource = {
  node: MediaStreamAudioSourceNode
  clones: MediaStreamTrack[]
}

/**
 * Смешивает локальный и удалённые микрофоны для модели.
 * Дорожки клонируются: оригинал остаётся у Jitsi и у `<audio>`, а Web Audio
 * в Chromium на общем треке с PeerConnection часто молчит.
 */
export function createMicMixer(): MicMixer {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const sources = new Map<string, MixerSource>()

  function drop(key: string): void {
    const existing = sources.get(key)
    if (!existing) return
    existing.node.disconnect()
    for (const clone of existing.clones) {
      try {
        clone.stop()
      } catch {
        // Уже остановлен.
      }
    }
    sources.delete(key)
  }

  function sync(key: string, stream: MediaStream | null): void {
    drop(key)
    if (!stream) return
    const originals = stream.getAudioTracks().filter((track) => track.readyState === 'live')
    if (originals.length === 0) return
    const clones = originals.map((track) => track.clone())
    const node = context.createMediaStreamSource(new MediaStream(clones))
    node.connect(destination)
    sources.set(key, { node, clones })
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  return {
    setRemoteStreams(streams) {
      const keys = new Set<string>()
      streams.forEach((stream, index) => {
        const key = `remote-${index}`
        keys.add(key)
        sync(key, stream)
      })
      for (const key of [...sources.keys()]) {
        if (key.startsWith('remote-') && !keys.has(key)) drop(key)
      }
    },
    setLocalMic(stream) {
      sync('local', stream)
    },
    outputStream: () => destination.stream,
    dispose() {
      for (const key of [...sources.keys()]) drop(key)
      void context.close()
    },
  }
}
