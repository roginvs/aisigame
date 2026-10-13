import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMicMixer, focusedModelParticipantId, streamsForModelHear } from './audioMix.ts'

class FakeTrack {
  id: string
  kind: string
  enabled: boolean
  readyState: string
  clone: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>

  constructor(kind: string, enabled = true, readyState = 'live', id = `track-${Math.random()}`) {
    this.id = id
    this.kind = kind
    this.enabled = enabled
    this.readyState = readyState
    this.clone = vi.fn(() => new FakeTrack(kind, enabled, readyState, `${id}-clone`))
    this.stop = vi.fn()
  }
}

class FakeMediaStream {
  tracks: FakeTrack[]

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getTracks() {
    return this.tracks
  }
}

class FakeAudioContext {
  destination = {}
  state = 'running'
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  createGain = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
  }))
  createMediaStreamDestination = vi.fn(() => ({
    stream: new FakeMediaStream(),
  }))
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
}

describe('focusedModelParticipantId', () => {
  it('сужает микс до выбирающего и отвечающего', () => {
    expect(focusedModelParticipantId('choosing.listening', 'chooser', 'answerer')).toBe('chooser')
    expect(focusedModelParticipantId('choosing.resolving', 'chooser', 'answerer')).toBe('chooser')
    expect(focusedModelParticipantId('answering.waiting', 'chooser', 'answerer')).toBe('answerer')
    expect(focusedModelParticipantId('answering.hearing', 'chooser', 'answerer')).toBe('answerer')
  })

  it('в остальных фазах и при неизвестном id оставляет общий микс', () => {
    expect(focusedModelParticipantId('buzzing.open', 'chooser', 'answerer')).toBeNull()
    expect(focusedModelParticipantId('lobby', null, null)).toBeNull()
    expect(focusedModelParticipantId('finalBets.hearing', 'a', 'b')).toBeNull()
    expect(focusedModelParticipantId('choosing.listening', null, 'answerer')).toBeNull()
    expect(focusedModelParticipantId('answering.waiting', 'chooser', null)).toBeNull()
  })

  it('с «Меньше слышать» глушит партию вне выбора и ответа, лобби оставляет общим', () => {
    expect(focusedModelParticipantId('buzzing.open', 'chooser', 'answerer', true)).toBe(false)
    expect(focusedModelParticipantId('reading.sealed', 'chooser', 'answerer', true)).toBe(false)
    expect(focusedModelParticipantId('finalBets.hearing', 'a', 'b', true, 'bettor')).toBe('bettor')
    expect(focusedModelParticipantId('welcoming', null, null, true)).toBe(false)
    expect(focusedModelParticipantId('startMenu', null, null, true)).toBeNull()
    expect(focusedModelParticipantId('choosing.listening', 'chooser', 'answerer', true)).toBe('chooser')
    expect(focusedModelParticipantId('answering.waiting', 'chooser', 'answerer', true)).toBe('answerer')
  })
})


it('keeps the current final bettor audible with or without turn-only mode', () => {
  for (const turnOnly of [true, false]) {
    for (const phase of ['finalBets.asking', 'finalBets.hearing', 'finalBets.resolving']) {
      expect(focusedModelParticipantId(phase, 'chooser', 'answerer', turnOnly, 'bettor')).toBe('bettor')
    }
    expect(focusedModelParticipantId('finalBets.hearing', null, null, turnOnly, null)).toBeNull()
  }
})

describe('streamsForModelHear', () => {
  const remotes = [
    { id: 'a', stream: { id: 'sa' } as unknown as MediaStream },
    { id: 'b', stream: { id: 'sb' } as unknown as MediaStream },
  ]
  const local = { id: 'local' } as unknown as MediaStream

  it('без фокуса отдаёт всех', () => {
    expect(
      streamsForModelHear({ remotes, localId: 'local', localStream: local, focusParticipantId: null }),
    ).toEqual({ remotes, local })
  })

  it('с фокусом оставляет только выбранного удалённого и глушит локальный чужой микрофон', () => {
    expect(
      streamsForModelHear({ remotes, localId: 'local', localStream: local, focusParticipantId: 'b' }),
    ).toEqual({ remotes: [remotes[1]], local: null })
  })

  it('если фокус — локальный участник, оставляет только его микрофон', () => {
    expect(
      streamsForModelHear({ remotes, localId: 'local', localStream: local, focusParticipantId: 'local' }),
    ).toEqual({ remotes: [], local })
  })

  it('false — никого не отдаёт в микс модели', () => {
    expect(
      streamsForModelHear({ remotes, localId: 'local', localStream: local, focusParticipantId: false }),
    ).toEqual({ remotes: [], local: null })
  })

  it('устаревший фокус (участника нет в комнате после reload) — слушаем всех', () => {
    expect(
      streamsForModelHear({
        remotes, localId: 'local', localStream: local, focusParticipantId: 'gone', presentIds: new Set(['a', 'b']),
      }),
    ).toEqual({ remotes, local })
  })

  it('фокус на присутствующего, но заглушённого — по-прежнему никого лишнего', () => {
    expect(
      streamsForModelHear({
        remotes: [remotes[0]!], localId: 'local', localStream: local, focusParticipantId: 'b', presentIds: new Set(['a', 'b']),
      }),
    ).toEqual({ remotes: [], local: null })
  })

  it('локальный фокус не считается устаревшим, даже если его нет в presentIds', () => {
    expect(
      streamsForModelHear({
        remotes, localId: 'local', localStream: local, focusParticipantId: 'local', presentIds: new Set(['a']),
      }),
    ).toEqual({ remotes: [], local })
  })
})

describe('createMicMixer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext(this: FakeAudioContext) {
        Object.assign(this, new FakeAudioContext())
      }),
    )
    vi.stubGlobal('MediaStream', FakeMediaStream)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clones remote audio for the model mix', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio', true, 'live', 'remote-a')
    const remoteVideo = new FakeTrack('video', true, 'live', 'remote-v')
    mixer.setRemoteStreams([
      {
        id: 'guest',
        stream: {
          getAudioTracks: () => [remoteAudio],
          getTracks: () => [remoteAudio, remoteVideo],
        } as unknown as MediaStream,
      },
    ])

    expect(remoteAudio.clone).toHaveBeenCalledTimes(1)
    expect(remoteVideo.clone).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('does not clone the local mic so Jitsi mute still reaches the model', () => {
    const mixer = createMicMixer()
    const localAudio = new FakeTrack('audio', true, 'live', 'local-a')
    mixer.setLocalMic({
      getAudioTracks: () => [localAudio],
      getTracks: () => [localAudio],
    } as unknown as MediaStream)

    expect(localAudio.clone).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('stops remote clones when streams are cleared and leaves the original alone', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio', true, 'live', 'remote-a')
    mixer.setRemoteStreams([
      {
        id: 'guest',
        stream: {
          getAudioTracks: () => [remoteAudio],
          getTracks: () => [remoteAudio],
        } as unknown as MediaStream,
      },
    ])
    const clone = remoteAudio.clone.mock.results[0]?.value as FakeTrack
    mixer.setRemoteStreams([])

    expect(clone.stop).toHaveBeenCalledTimes(1)
    expect(remoteAudio.stop).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('keeps stable remote ids and skips re-clone when the same live tracks return', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio', true, 'live', 'remote-a')
    const stream = {
      getAudioTracks: () => [remoteAudio],
      getTracks: () => [remoteAudio],
    } as unknown as MediaStream
    mixer.setRemoteStreams([{ id: 'guest', stream }])
    mixer.setRemoteStreams([{ id: 'guest', stream }])

    expect(remoteAudio.clone).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })

  it('drops muted remotes and re-clones after unmute', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio', false, 'live', 'remote-a')
    const stream = {
      getAudioTracks: () => [remoteAudio],
      getTracks: () => [remoteAudio],
    } as unknown as MediaStream
    mixer.setRemoteStreams([{ id: 'guest', stream }])
    expect(remoteAudio.clone).not.toHaveBeenCalled()

    remoteAudio.enabled = true
    mixer.setRemoteStreams([{ id: 'guest', stream }])
    expect(remoteAudio.clone).toHaveBeenCalledTimes(1)

    const firstClone = remoteAudio.clone.mock.results[0]?.value as FakeTrack
    remoteAudio.enabled = false
    mixer.setRemoteStreams([{ id: 'guest', stream }])
    expect(firstClone.stop).toHaveBeenCalledTimes(1)

    remoteAudio.enabled = true
    mixer.setRemoteStreams([{ id: 'guest', stream }])
    expect(remoteAudio.clone).toHaveBeenCalledTimes(2)
    mixer.dispose()
  })

  it('does not stop the local mic track when the local source is cleared', () => {
    const mixer = createMicMixer()
    const localAudio = new FakeTrack('audio', true, 'live', 'local-a')
    mixer.setLocalMic({
      getAudioTracks: () => [localAudio],
      getTracks: () => [localAudio],
    } as unknown as MediaStream)
    mixer.setLocalMic(null)

    expect(localAudio.stop).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('re-clones when a participant\'s track is replaced (late mic / recover)', () => {
    const mixer = createMicMixer()
    const stream = (track: FakeTrack) =>
      ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream
    const first = new FakeTrack('audio', true, 'live', 'first')
    const second = new FakeTrack('audio', true, 'live', 'second')
    mixer.setRemoteStreams([{ id: 'guest', stream: stream(first) }])
    const firstClone = first.clone.mock.results[0]!.value as FakeTrack
    mixer.setRemoteStreams([{ id: 'guest', stream: stream(second) }])
    expect(firstClone.stop).toHaveBeenCalled()
    expect(second.clone).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })
})
