import { describe, expect, it } from 'vitest'
import type { ConferenceTile } from '../conference/media.ts'
import type { ConferenceJitsiPair } from '../conference/messages.ts'
import { matchConferenceTile } from './conferenceTileMatch.ts'

const tile = (id: string, name: string, isLocal = false, speaking = false): ConferenceTile => ({
  id, name, isLocal, micLive: true, cameraOn: true, speaking,
})

describe('matchConferenceTile — по id в Jitsi, не по имени', () => {
  const tiles = [tile('local', 'Маша', true), tile('j-vasya-1', 'Вася'), tile('j-vasya-2', 'Вася', false, true)]
  const pairs: ConferenceJitsiPair[] = [['j-vasya-1', 'c1'], ['j-vasya-2', 'c2'], ['local-x', 'me']]

  it('своё устройство — локальная плитка', () => {
    expect(matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'me', jitsiIds: pairs })?.id).toBe('local')
  })

  it('два «Васи» получают разные камеры и разную подсветку «говорит»', () => {
    const first = matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c1', jitsiIds: pairs })
    const second = matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c2', jitsiIds: pairs })
    expect(first?.id).toBe('j-vasya-1')
    expect(second?.id).toBe('j-vasya-2')
    expect(first?.speaking).toBe(false)
    expect(second?.speaking).toBe(true)
  })

  it('нет пары (снимок ещё не пришёл / hello не было) — пустая карточка, даже при совпадении имени', () => {
    expect(matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c3', jitsiIds: pairs })).toBeUndefined()
    expect(matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c1', jitsiIds: undefined })).toBeUndefined()
    expect(matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c1', jitsiIds: [] })).toBeUndefined()
  })

  it('без clientId — пусто (раньше угадывали по имени)', () => {
    expect(matchConferenceTile(tiles, { selfClientId: 'me', clientId: null, jitsiIds: pairs })).toBeUndefined()
  })

  it('id из пары не совпал ни с одной плиткой (участник вышел, устаревший id) — пусто', () => {
    expect(matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'gone', jitsiIds: [['old-id', 'gone']] })).toBeUndefined()
  })

  it('чужая пара не цепляет локальную плитку, даже если id совпал (BroadcastChannel: «local»)', () => {
    const local = [tile('local', 'Гость', true)]
    expect(matchConferenceTile(local, { selfClientId: 'me', clientId: 'master', jitsiIds: [['local', 'master']] })).toBeUndefined()
  })

  it('игрок с именем «Ведущая» — обычная плитка по своему id', () => {
    const named = [tile('j-host-named', 'Ведущая')]
    expect(matchConferenceTile(named, { selfClientId: 'me', clientId: 'cH', jitsiIds: [['j-host-named', 'cH']] })?.id).toBe('j-host-named')
  })

  it('переподключение игрока: новая пара — новая плитка, старой больше нет', () => {
    const after = [tile('j-vasya-1b', 'Вася')]
    expect(matchConferenceTile(after, { selfClientId: 'me', clientId: 'c1', jitsiIds: [['j-vasya-1b', 'c1']] })?.id).toBe('j-vasya-1b')
  })

  it('multi-seat: игроки одного устройства (один clientId) видят одну камеру', () => {
    const a = matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c1', jitsiIds: pairs })
    const b = matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'c1', jitsiIds: pairs })
    expect(a).toBe(b)
  })
})
