import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMicMixer, focusedModelParticipantId, LOCAL_KEY, modelHearGains, type MixerRemote } from './audioMix.ts'

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
  currentTime = 0
  createGain = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setTargetAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v }),
    },
  }))
  createAnalyser = vi.fn(() => ({ fftSize: 0, connect: vi.fn(), disconnect: vi.fn() }))
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

describe('modelHearGains', () => {
  const remotes = [
    { key: 'r1', participantId: 'a', audible: true },
    { key: 'r2', participantId: 'b', audible: true },
    { key: 'r3', participantId: 'c', audible: false },
  ]
  const local = { participantId: 'me', audible: true }
  const levels = (focus: Parameters<typeof modelHearGains>[0]['focus'], l = local, r = remotes) =>
    Object.fromEntries(modelHearGains({ remotes: r, local: l, focus }).gains)

  it('null — все живые на 1, заглушённые 0', () => {
    expect(levels(null)).toEqual({ r1: 1, r2: 1, r3: 0, [LOCAL_KEY]: 1 })
  })

  it('фокус на участнике — только его гейн 1', () => {
    expect(levels('b')).toEqual({ r1: 0, r2: 1, r3: 0, [LOCAL_KEY]: 0 })
    expect(levels('me')).toEqual({ r1: 0, r2: 0, r3: 0, [LOCAL_KEY]: 1 })
  })

  it('false («Меньше слышать» вне хода) — все 0', () => {
    expect(levels(false)).toEqual({ r1: 0, r2: 0, r3: 0, [LOCAL_KEY]: 0 })
  })

  it('фокус без живой незаглушённой дорожки — fallback на всех', () => {
    const muted = modelHearGains({ remotes, local, focus: 'c' })
    expect(muted.fallback).toBe(true)
    expect(Object.fromEntries(muted.gains)).toEqual({ r1: 1, r2: 1, r3: 0, [LOCAL_KEY]: 1 })
    expect(modelHearGains({ remotes, local, focus: 'gone' }).fallback).toBe(true)
    expect(modelHearGains({ remotes, local, focus: 'a' }).fallback).toBe(false)
  })

  it('фазы: ответ слышит только отвечающего, «Меньше слышать» глушит вне хода', () => {
    expect(levels(focusedModelParticipantId('answering.waiting', 'a', 'b'))).toEqual({ r1: 0, r2: 1, r3: 0, [LOCAL_KEY]: 0 })
    expect(levels(focusedModelParticipantId('choosing.listening', 'a', 'b'))).toEqual({ r1: 1, r2: 0, r3: 0, [LOCAL_KEY]: 0 })
    expect(levels(focusedModelParticipantId('reading.armed', 'a', 'b', true))).toEqual({ r1: 0, r2: 0, r3: 0, [LOCAL_KEY]: 0 })
    expect(levels(focusedModelParticipantId('reading.armed', 'a', 'b', false))).toEqual({ r1: 1, r2: 1, r3: 0, [LOCAL_KEY]: 1 })
  })
})

describe('createMicMixer', () => {
  type Ctx = FakeAudioContext
  let ctx: Ctx
  beforeEach(() => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext(this: FakeAudioContext) {
        Object.assign(this, new FakeAudioContext())
        ctx = this
      }),
    )
    vi.stubGlobal('MediaStream', FakeMediaStream)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stream = (...tracks: FakeTrack[]) => new FakeMediaStream(tracks) as unknown as MediaStream
  const remote = (key: string, participantId: string, track: FakeTrack, muted = false): MixerRemote =>
    ({ key, participantId, stream: stream(track), muted })
  const noLocal = { participantId: 'me', stream: null, live: false }
  /** Гейн-ноды источников по порядку создания (первая — шина). */
  const sourceGains = () => ctx.createGain.mock.results.slice(1).map((r) => r.value as { gain: { value: number } })

  it('клонирует удалённые дорожки, видео игнорирует', () => {
    const mixer = createMicMixer()
    const audio = new FakeTrack('audio', true, 'live', 'a')
    const video = new FakeTrack('video', true, 'live', 'v')
    mixer.update({ remotes: [{ key: 't1', participantId: 'g', stream: stream(audio, video), muted: false }], local: noLocal, focus: null })
    expect(audio.clone).toHaveBeenCalledTimes(1)
    expect(video.clone).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('смена фокуса меняет только гейн, источники не пересоздаются', () => {
    const mixer = createMicMixer()
    const a = new FakeTrack('audio', true, 'live', 'a')
    const b = new FakeTrack('audio', true, 'live', 'b')
    const remotes = [remote('t1', 'pa', a), remote('t2', 'pb', b)]
    mixer.update({ remotes, local: noLocal, focus: null })
    expect(sourceGains().map((g) => g.gain.value)).toEqual([1, 1])
    mixer.update({ remotes, local: noLocal, focus: 'pb' })
    expect(sourceGains().map((g) => g.gain.value)).toEqual([0, 1])
    mixer.update({ remotes, local: noLocal, focus: false })
    expect(sourceGains().map((g) => g.gain.value)).toEqual([0, 0])
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(2)
    expect(a.clone).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })

  it('muted — гейн 0 без пересборки; фокус на заглушённом — fallback', () => {
    const mixer = createMicMixer()
    const a = new FakeTrack('audio', true, 'live', 'a')
    const b = new FakeTrack('audio', true, 'live', 'b')
    const result = mixer.update({ remotes: [remote('t1', 'pa', a), remote('t2', 'pb', b, true)], local: noLocal, focus: 'pb' })
    expect(result.fallback).toBe(true)
    expect(sourceGains().map((g) => g.gain.value)).toEqual([1, 0])
    mixer.update({ remotes: [remote('t1', 'pa', a), remote('t2', 'pb', b)], local: noLocal, focus: 'pb' })
    expect(sourceGains().map((g) => g.gain.value)).toEqual([0, 1])
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(2)
    mixer.dispose()
  })

  it('смена владельца дорожки: фокус следует за текущим getParticipantId', () => {
    const mixer = createMicMixer()
    const a = new FakeTrack('audio', true, 'live', 'a')
    mixer.update({ remotes: [remote('t1', 'old', a)], local: noLocal, focus: 'answerer' })
    // Раньше дорожка числилась за 'old' → fallback; после owner_set — за 'answerer'.
    const after = mixer.update({ remotes: [remote('t1', 'answerer', a)], local: noLocal, focus: 'answerer' })
    expect(after.fallback).toBe(false)
    expect(sourceGains().map((g) => g.gain.value)).toEqual([1])
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })

  it('замена или конец дорожки пересоздаёт/убирает источник и останавливает клон', () => {
    const mixer = createMicMixer()
    const first = new FakeTrack('audio', true, 'live', 'first')
    const second = new FakeTrack('audio', true, 'live', 'second')
    mixer.update({ remotes: [remote('t1', 'g', first)], local: noLocal, focus: null })
    const firstClone = first.clone.mock.results[0]!.value as FakeTrack
    mixer.update({ remotes: [remote('t1', 'g', second)], local: noLocal, focus: null })
    expect(firstClone.stop).toHaveBeenCalled()
    expect(first.stop).not.toHaveBeenCalled()
    const secondClone = second.clone.mock.results[0]!.value as FakeTrack
    second.readyState = 'ended'
    mixer.update({ remotes: [remote('t1', 'g', second)], local: noLocal, focus: null })
    expect(secondClone.stop).toHaveBeenCalled()
    mixer.update({ remotes: [], local: noLocal, focus: null })
    mixer.dispose()
  })

  it('локальный микрофон не клонируется; выключенный — гейн 0', () => {
    const mixer = createMicMixer()
    const mic = new FakeTrack('audio', true, 'live', 'mic')
    mixer.update({ remotes: [], local: { participantId: 'me', stream: stream(mic), live: true }, focus: null })
    expect(mic.clone).not.toHaveBeenCalled()
    expect(sourceGains().map((g) => g.gain.value)).toEqual([1])
    mixer.update({ remotes: [], local: { participantId: 'me', stream: stream(mic), live: false }, focus: null })
    expect(sourceGains().map((g) => g.gain.value)).toEqual([0])
    mixer.dispose()
    expect(mic.stop).not.toHaveBeenCalled()
  })

  it('meter() отводит шину на AnalyserNode один раз', () => {
    const mixer = createMicMixer()
    const first = mixer.meter()
    expect(mixer.meter()).toBe(first)
    expect(ctx.createAnalyser).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })
})
