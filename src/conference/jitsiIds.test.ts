import { describe, expect, it } from 'vitest'
import { focusedModelParticipantId, modelHearGains } from './audioMix.ts'
import { jitsiPairs } from './buildSnapshot.ts'
import { jitsiIdOfClient } from './jitsiIds.ts'
import { modelHearsParticipant } from './media.ts'
import { validJitsiPairs, type ConferenceJitsiPair } from './messages.ts'

const roster = [
  { clientId: 'master', isMaster: true },
  { clientId: 'c1', isMaster: false },
  { clientId: 'c2', isMaster: false },
]

describe('jitsiPairs — пары [jitsiId, clientId] у мастера', () => {
  it('мастер — своё соединение, гость — отправитель его hello; сначала jitsiId', () => {
    const endpoints: Record<string, string> = { c1: 'j1', c2: 'j2' }
    expect(jitsiPairs(roster, { self: 'jm', endpointOf: (id) => endpoints[id] ?? null }))
      .toEqual([['jm', 'master'], ['j1', 'c1'], ['j2', 'c2']])
  })

  it('без известного id пары нет (BroadcastChannel у мастера, гость без hello)', () => {
    expect(jitsiPairs(roster, { self: null, endpointOf: (id) => (id === 'c1' ? 'j1' : null) }))
      .toEqual([['j1', 'c1']])
  })

  it('повтор clientId в составе даёт одну пару (одно устройство — одно соединение)', () => {
    const dup = [...roster, { clientId: 'c1', isMaster: false }]
    const pairs = jitsiPairs(dup, { self: 'jm', endpointOf: (id) => `j-${id}` })
    expect(pairs.filter(([, clientId]) => clientId === 'c1')).toHaveLength(1)
    expect(validJitsiPairs(pairs)).toBe(true)
  })

  it('переподключение гостя с новым endpoint — пара сразу с новым id', () => {
    let endpoint = 'j1'
    const ids = { self: 'jm', endpointOf: () => endpoint }
    expect(jitsiPairs([roster[1]!], ids)).toEqual([['j1', 'c1']])
    endpoint = 'j1-new'
    expect(jitsiPairs([roster[1]!], ids)).toEqual([['j1-new', 'c1']])
  })
})

describe('jitsiIdOfClient', () => {
  const pairs: ConferenceJitsiPair[] = [['j1', 'c1'], ['j2', 'c2']]
  it('находит id по устройству', () => {
    expect(jitsiIdOfClient(pairs, 'c2')).toBe('j2')
  })
  it('нет пар / нет clientId / нет пары — null (снимок ещё не пришёл)', () => {
    expect(jitsiIdOfClient(undefined, 'c1')).toBeNull()
    expect(jitsiIdOfClient(pairs, null)).toBeNull()
    expect(jitsiIdOfClient(pairs, undefined)).toBeNull()
    expect(jitsiIdOfClient(pairs, 'c9')).toBeNull()
  })
})

describe('validJitsiPairs', () => {
  it('принимает пустой список и обычные пары', () => {
    expect(validJitsiPairs([])).toBe(true)
    expect(validJitsiPairs([['j1', 'c1'], ['j2', 'c2']])).toBe(true)
  })
  it('один jitsiId у двух clientId допустим формально (решает мастер), а повтор clientId — нет', () => {
    expect(validJitsiPairs([['j1', 'c1'], ['j1', 'c2']])).toBe(true)
    expect(validJitsiPairs([['j1', 'c1'], ['j2', 'c1']])).toBe(false)
  })
  it.each([
    ['не массив', { j1: 'c1' }],
    ['null', null],
    ['пара не массив', ['j1']],
    ['пара из одного', [['j1']]],
    ['пара из трёх', [['j1', 'c1', 'x']]],
    ['пустой id', [['', 'c1']]],
    ['пустой clientId', [['j1', '']]],
    ['число', [[1, 'c1']]],
    ['слишком длинный id', [['x'.repeat(201), 'c1']]],
    ['слишком много пар', Array.from({ length: 1_001 }, (_, i) => [`j${i}`, `c${i}`])],
  ])('отклоняет: %s', (_label, value) => {
    expect(validJitsiPairs(value)).toBe(false)
  })
})

describe('фокус модели на отвечающем по id — два «Васи»', () => {
  // Два игрока с одинаковым именем на разных устройствах; у каждого своя дорожка.
  const pairs: ConferenceJitsiPair[] = [['jm', 'master'], ['j-vasya-1', 'c1'], ['j-vasya-2', 'c2']]
  const remotes = [
    { key: 't1', participantId: 'j-vasya-1', audible: true },
    { key: 't2', participantId: 'j-vasya-2', audible: true },
  ]

  it.each([
    ['c1', 't1', 't2'],
    ['c2', 't2', 't1'],
  ])('отвечает %s — модель слышит только %s', (clientId, heard, muted) => {
    const focus = focusedModelParticipantId('answering.waiting', null, jitsiIdOfClient(pairs, clientId))
    const { gains, fallback } = modelHearGains({ remotes, local: { participantId: 'jm', audible: true }, focus })
    expect(fallback).toBe(false)
    expect(gains.get(heard)).toBe(1)
    expect(gains.get(muted)).toBe(0)
    expect(gains.get('local')).toBe(0)
  })

  it('выбирающий и ставящий фокусируются тем же способом', () => {
    expect(focusedModelParticipantId('choosing.listening', jitsiIdOfClient(pairs, 'c2'), null)).toBe('j-vasya-2')
    expect(focusedModelParticipantId('auction.bidding', null, null, false, jitsiIdOfClient(pairs, 'c1'))).toBe('j-vasya-1')
  })

  it('устаревший id отвечающего (переподключился, снимок ещё старый) — fallback: слышим всех, а не никого', () => {
    const focus = focusedModelParticipantId('answering.waiting', null, 'j-vasya-1-old')
    const { gains, fallback } = modelHearGains({ remotes, local: { participantId: 'jm', audible: false }, focus })
    expect(fallback).toBe(true)
    expect(gains.get('t1')).toBe(1)
    expect(gains.get('t2')).toBe(1)
  })

  it('игрок по имени «Ведущая» попадает в микс и в фокус: его id не служебный', () => {
    const service = { host: 'j-bot', sounds: 'j-snd' }
    const named: ConferenceJitsiPair[] = [['j-named-host', 'cH']]
    expect(modelHearsParticipant('j-named-host', service)).toBe(true)
    const focus = focusedModelParticipantId('answering.waiting', null, jitsiIdOfClient(named, 'cH'))
    const { gains } = modelHearGains({
      remotes: [{ key: 'tH', participantId: 'j-named-host', audible: true }],
      local: { participantId: 'jm', audible: true },
      focus,
    })
    expect(gains.get('tH')).toBe(1)
  })

  it('multi-seat: два игрока одного устройства — один jitsiId, фокус на общей дорожке', () => {
    // Оба места на устройстве c1 → один и тот же id; модель слышит mic устройства (решение UNIFY_MODES).
    const players = [{ id: 5, clientId: 'c1' }, { id: 6, clientId: 'c1' }]
    const ids = players.map((player) => jitsiIdOfClient(pairs, player.clientId))
    expect(ids).toEqual(['j-vasya-1', 'j-vasya-1'])
  })
})
