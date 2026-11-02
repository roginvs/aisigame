import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brokenCloneTarget, createMicMixer, focusedModelParticipantId, hearParticipantIds, hearWatchLines, LOCAL_KEY, modelHearGains, nextHearBinding, type MixerRemote } from './audioMix.ts'

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

  it('вне хода общий микс; на ходе без id — тишина, не чужие микрофоны', () => {
    expect(focusedModelParticipantId('buzzing.open', 'chooser', 'answerer')).toBeNull()
    expect(focusedModelParticipantId('lobby', null, null)).toBeNull()
    expect(focusedModelParticipantId('finalBets.hearing', 'a', 'b')).toBe(false)
    expect(focusedModelParticipantId('choosing.listening', null, 'answerer')).toBe(false)
    expect(focusedModelParticipantId('answering.waiting', 'chooser', null)).toBe(false)
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
    expect(focusedModelParticipantId('finalBets.hearing', null, null, turnOnly, null)).toBe(false)
  }
})

describe('привязка игрока к дорожкам', () => {
  const owners = ['j-old', 'j-new', 'j-other']

  it('перезаход: слышны и старая, и новая дорожка того же игрока, чужая нет', () => {
    const ids = hearParticipantIds({
      clientId: 'c1',
      liveEndpointIds: ['j-new'],
      pairs: [['j-new', 'c1'], ['j-other', 'c2']],
      selfParticipantId: null,
      liveOwnerIds: owners,
      previousBoundIds: ['j-old'],
    })
    expect(ids).toEqual(['j-new', 'j-old'])
    const { gains, fallback } = modelHearGains({
      remotes: owners.map((participantId) => ({ key: participantId, participantId, audible: true })),
      local: { participantId: 'master', audible: true },
      focus: ids,
    })
    expect(fallback).toBe(false)
    expect(gains.get('j-old')).toBe(1)
    expect(gains.get('j-new')).toBe(1)
    expect(gains.get('j-other')).toBe(0)
    expect(gains.get(LOCAL_KEY)).toBe(0)
  })

  it('старый id уже принадлежит другому — его дорожка гаснет', () => {
    const ids = hearParticipantIds({
      clientId: 'c1',
      liveEndpointIds: ['j-new'],
      pairs: [['j-new', 'c1'], ['j-old', 'c2']],
      selfParticipantId: null,
      liveOwnerIds: owners,
      previousBoundIds: ['j-old'],
    })
    expect(ids).toEqual(['j-new'])
  })

  it('смена трека: фокус на новом id владельца, не на прежнем', () => {
    const ids = hearParticipantIds({
      clientId: 'c1',
      liveEndpointIds: ['j-new'],
      pairs: [['j-new', 'c1']],
      selfParticipantId: null,
      liveOwnerIds: ['j-new', 'j-other'],
      previousBoundIds: [],
    })
    const { gains } = modelHearGains({
      remotes: [
        { key: 't', participantId: 'j-new', audible: true },
        { key: 'o', participantId: 'j-other', audible: true },
      ],
      local: { participantId: 'master', audible: false },
      focus: ids,
    })
    expect(gains.get('t')).toBe(1)
    expect(gains.get('o')).toBe(0)
  })

  it('две вкладки одного игрока — обе дорожки в миксе, чужая нет', () => {
    const ids = hearParticipantIds({
      clientId: 'c1',
      liveEndpointIds: ['j-phone', 'j-laptop'],
      pairs: [['j-laptop', 'c1'], ['j-other', 'c2']],
      selfParticipantId: null,
      liveOwnerIds: ['j-phone', 'j-laptop', 'j-other'],
      previousBoundIds: [],
    })
    expect(ids).toEqual(['j-phone', 'j-laptop'])
    const { gains } = modelHearGains({
      remotes: [
        { key: 'phone', participantId: 'j-phone', audible: true },
        { key: 'laptop', participantId: 'j-laptop', audible: true },
        { key: 'other', participantId: 'j-other', audible: true },
      ],
      local: { participantId: 'master', audible: true },
      focus: ids,
    })
    expect(gains.get('phone')).toBe(1)
    expect(gains.get('laptop')).toBe(1)
    expect(gains.get('other')).toBe(0)
    expect(gains.get(LOCAL_KEY)).toBe(0)
  })

  it('две дорожки одного jitsi-участника обе в миксе, соседний игрок нет', () => {
    const { gains } = modelHearGains({
      remotes: [
        { key: 'mic', participantId: 'j1', audible: true },
        { key: 'mic-2', participantId: 'j1', audible: true },
        { key: 'other', participantId: 'j2', audible: true },
      ],
      local: { participantId: 'master', audible: true },
      focus: ['j1'],
    })
    expect(gains.get('mic')).toBe(1)
    expect(gains.get('mic-2')).toBe(1)
    expect(gains.get('other')).toBe(0)
  })

  it('апелляция слышит дорожку отвечающего, не выбирающего', () => {
    expect(focusedModelParticipantId('appealCue', 'c-choose', 'c-answer')).toBe('c-answer')
    const ids = hearParticipantIds({
      clientId: 'c-answer',
      liveEndpointIds: ['j-answer'],
      pairs: [['j-choose', 'c-choose'], ['j-answer', 'c-answer']],
      selfParticipantId: null,
      liveOwnerIds: ['j-choose', 'j-answer'],
      previousBoundIds: ['j-choose'],
    })
    expect(ids).toEqual(['j-answer'])
  })

  it('смена id ведущей не попадает в слух игрока', () => {
    const ids = hearParticipantIds({
      clientId: 'c1',
      liveEndpointIds: ['j1'],
      pairs: [['j1', 'c1']],
      selfParticipantId: null,
      liveOwnerIds: ['j1', 'host-old', 'host-new'],
      previousBoundIds: ['host-old'],
      ignoreIds: ['host-old', 'host-new'],
    })
    expect(ids).toEqual(['j1'])
    const { gains } = modelHearGains({
      remotes: [
        { key: 'p', participantId: 'j1', audible: true },
        { key: 'h', participantId: 'host-new', audible: true },
      ],
      local: { participantId: 'master', audible: false },
      focus: ids,
    })
    expect(gains.get('p')).toBe(1)
    expect(gains.get('h')).toBe(0)
  })

  it('битый клон пересоздаётся только у дорожки фокуса', () => {
    const hit = brokenCloneTarget([
      { key: 'other', participantId: 'j2', rms: 0.001, jitsi: 0.9 },
      { key: 'mine', participantId: 'j1', rms: 0.01, jitsi: 0.8 },
    ], ['j1'], 0.025, 0.02)
    expect(hit).toEqual({ key: 'mine', participantId: 'j1', jitsi: 0.8, rms: 0.01 })
    expect(brokenCloneTarget([
      { key: 'other', participantId: 'j2', rms: 0.001, jitsi: 0.9 },
    ], ['j1'], 0.025, 0.02)).toBeNull()
  })

  it('быстрая смена отвечающего после кнопки оставляет только нового', () => {
    let binding: { clientId: string | null; ids: readonly string[] } = { clientId: null, ids: [] }
    const step = (clientId: string, endpoint: string) => {
      binding = nextHearBinding(binding, clientId, (previousBoundIds) => hearParticipantIds({
        clientId,
        liveEndpointIds: [endpoint],
        pairs: [['ja', 'a'], ['jb', 'b']],
        selfParticipantId: null,
        liveOwnerIds: ['ja', 'jb'],
        previousBoundIds,
      }))
      return binding.ids
    }
    expect(step('a', 'ja')).toEqual(['ja'])
    expect(step('b', 'jb')).toEqual(['jb'])
  })

  it('переответ того же игрока сохраняет его живые дорожки и не открывает чужую', () => {
    let binding: { clientId: string | null; ids: readonly string[] } = { clientId: null, ids: [] }
    const step = (endpoints: readonly string[], stillLive: readonly string[]) => {
      binding = nextHearBinding(binding, 'c1', (previousBoundIds) => hearParticipantIds({
        clientId: 'c1',
        liveEndpointIds: endpoints,
        pairs: [...endpoints.map((id) => [id, 'c1'] as const), ['j-other', 'c2'] as const],
        selfParticipantId: null,
        liveOwnerIds: [...endpoints, ...stillLive, 'j-other'],
        previousBoundIds,
      }))
      return [...binding.ids].sort()
    }
    expect(step(['j-old'], [])).toEqual(['j-old'])
    expect(step(['j-new'], ['j-old'])).toEqual(['j-new', 'j-old'])
  })

  it('смена id мастера-отвечающего: новый локальный слышен, ставший ведущей — нет', () => {
    const ids = hearParticipantIds({
      clientId: 'master',
      liveEndpointIds: [],
      pairs: [['j-other', 'c2']],
      selfParticipantId: 'local-new',
      liveOwnerIds: ['local-new', 'local-old', 'j-other'],
      previousBoundIds: ['local-old'],
      ignoreIds: ['local-old'],
    })
    expect(ids).toEqual(['local-new'])
    const { gains } = modelHearGains({
      remotes: [
        { key: 'host', participantId: 'local-old', audible: true },
        { key: 'other', participantId: 'j-other', audible: true },
      ],
      local: { participantId: 'local-new', audible: true },
      focus: ids,
    })
    expect(gains.get(LOCAL_KEY)).toBe(1)
    expect(gains.get('host')).toBe(0)
    expect(gains.get('other')).toBe(0)
  })
})

describe('строки слуха в техническую колонку', () => {
  it('непонятная дорожка, две дорожки игрока и ни одной у активного', () => {
    expect(hearWatchLines({
      activeName: 'Маша',
      activeIds: ['gone'],
      owners: [
        { id: 'j-a', name: '' },
        { id: 'j-b', name: '' },
        { id: 'j-x', name: 'Незнакомец' },
        { id: 'host', name: 'Ведущая' },
      ],
      known: [
        { id: 'j-a', name: 'Маша' },
        { id: 'j-b', name: 'Маша' },
      ],
      serviceIds: ['host'],
    })).toEqual([
      'техническое: непонятная дорожка Незнакомец (j-x), не сопоставлена с игроком',
      'техническое: у Маша 2 живых дорожек: j-a, j-b',
      'техническое: у Маша нет ни одной живой дорожки',
    ])
  })
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

  it('фокус без живой дорожки не открывает остальных: отвечает не тот, кого слышно', () => {
    const muted = modelHearGains({ remotes, local, focus: 'c' })
    expect(muted.fallback).toBe(true)
    expect(Object.fromEntries(muted.gains)).toEqual({ r1: 0, r2: 0, r3: 0, [LOCAL_KEY]: 0 })
    const gone = modelHearGains({ remotes, local, focus: 'gone' })
    expect(gone.fallback).toBe(true)
    expect(Object.fromEntries(gone.gains)).toEqual({ r1: 0, r2: 0, r3: 0, [LOCAL_KEY]: 0 })
    expect(modelHearGains({ remotes, local, focus: 'a' }).fallback).toBe(false)
  })

  it('два игрока говорят, отвечает А — в модель идёт только А, даже если дорожка А пропала', () => {
    const onlyB = [
      { key: 'rB', participantId: 'b', audible: true },
      { key: 'rA', participantId: 'a', audible: false },
    ]
    const focus = focusedModelParticipantId('answering.waiting', 'b', 'a', true)
    const { gains, fallback } = modelHearGains({
      remotes: onlyB,
      local: { participantId: 'master', audible: true },
      focus,
    })
    expect(focus).toBe('a')
    expect(fallback).toBe(true)
    expect(gains.get('rA')).toBe(0)
    expect(gains.get('rB')).toBe(0)
    expect(gains.get(LOCAL_KEY)).toBe(0)
    const both = modelHearGains({
      remotes: [
        { key: 'rB', participantId: 'b', audible: true },
        { key: 'rA', participantId: 'a', audible: true },
      ],
      local: { participantId: 'master', audible: true },
      focus,
    })
    expect(both.fallback).toBe(false)
    expect(both.gains.get('rA')).toBe(1)
    expect(both.gains.get('rB')).toBe(0)
    expect(both.gains.get(LOCAL_KEY)).toBe(0)
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
      // Конструктор возвращает объект: `new AudioContext()` отдаёт именно этот фейк.
      vi.fn(function AudioContext() {
        ctx = new FakeAudioContext()
        return ctx
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

  it('trace: источник добавлен/снят; reattach пересоздаёт клон той же дорожки', () => {
    const events: string[] = []
    const mixer = createMicMixer((event) => events.push(`${event.kind}:${event.key}`))
    const a = new FakeTrack('audio', true, 'live', 'a')
    mixer.update({ remotes: [remote('t1', 'pa', a)], local: noLocal, focus: 'pa' })
    mixer.update({ remotes: [remote('t1', 'pa', a)], local: noLocal, focus: 'pa' })
    expect(a.clone).toHaveBeenCalledTimes(1)
    mixer.reattach('remote-t1')
    mixer.update({ remotes: [remote('t1', 'pa', a)], local: noLocal, focus: 'pa' })
    expect(a.clone).toHaveBeenCalledTimes(2)
    mixer.update({ remotes: [], local: noLocal, focus: 'pa' })
    expect(events).toEqual(['added:remote-t1', 'replaced:remote-t1', 'removed:remote-t1'])
    expect(mixer.levels()).toEqual([])
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

  it('muted — гейн 0 без пересборки; фокус на заглушённом не открывает другого', () => {
    const mixer = createMicMixer()
    const a = new FakeTrack('audio', true, 'live', 'a')
    const b = new FakeTrack('audio', true, 'live', 'b')
    const result = mixer.update({ remotes: [remote('t1', 'pa', a), remote('t2', 'pb', b, true)], local: noLocal, focus: 'pb' })
    expect(result.fallback).toBe(true)
    expect(sourceGains().map((g) => g.gain.value)).toEqual([0, 0])
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
