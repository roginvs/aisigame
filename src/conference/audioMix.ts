export type MicMixer = {
  setRemoteStreams: (streams: MediaStream[]) => void
  setLocalMic: (stream: MediaStream | null) => void
  outputStream: () => MediaStream | null
  dispose: () => void
}

export function createMicMixer(): MicMixer {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const sources = new Map<string, MediaStreamAudioSourceNode>()

  function sync(key: string, stream: MediaStream | null): void {
    const existing = sources.get(key)
    if (existing) {
      existing.disconnect()
      sources.delete(key)
    }
    if (!stream) return
    const track = stream.getAudioTracks()[0]
    if (!track) return
    const node = context.createMediaStreamSource(new MediaStream([track]))
    node.connect(destination)
    sources.set(key, node)
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
        if (key.startsWith('remote-') && !keys.has(key)) sync(key, null)
      }
    },
    setLocalMic(stream) {
      sync('local', stream)
    },
    outputStream: () => destination.stream,
    dispose() {
      for (const node of sources.values()) node.disconnect()
      sources.clear()
      void context.close()
    },
  }
}
