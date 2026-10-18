import { describe, expect, it } from 'vitest'
import {
  lobbyEveryoneReady,
  lobbyRosterStatusLine,
  lobbySpeechInstructions,
} from './lobbySpeech.ts'
import type { RosterEntry } from './roster.ts'
import { jokeCoin } from '../game/jokeCoin.ts'

function entry(patch: Partial<RosterEntry> & Pick<RosterEntry, 'clientId' | 'name'>): RosterEntry {
  return {
    playerId: null,
    percent: 0,
    downloadBps: null,
    etaSeconds: null,
    packPhase: 'connecting',
    ready: false,
    hashOk: false,
    lastSeen: 0,
    stale: false,
    hidden: false,
    isMaster: false,
    ...patch,
  }
}

it('includes explicit public chat context in lobby cues', () => {
  const text = lobbySpeechInstructions({ kind: 'idle', packName: 'Демо', packSummary: 'Один раунд', roster: [], publicContext: 'Маша: CHAT_MARKER' })
  expect(text).toContain('Маша: CHAT_MARKER')
})

describe('lobbySpeechInstructions', () => {
  it('правило про «отключился» — только когда об этом говорят', () => {
    const base = { kind: 'update' as const, packName: 'Демо', packSummary: 'Раундов: 1.', roster: [] }
    expect(lobbySpeechInstructions(base)).not.toContain('у тебя он на связи')
    expect(lobbySpeechInstructions({ ...base, publicContext: 'Маша: кажется, Вася отключился' })).toContain('у тебя он на связи')
  })

  it('разрешает коротко участвовать в разговоре игроков без длинного монолога', () => {
    const instructions = lobbySpeechInstructions({
      kind: 'idle',
      packName: 'Демо',
      packSummary: 'Один раунд.',
      roster: [],
    })

    expect(instructions).toContain('Можно подхватить недавний разговор')
    expect(instructions).toContain('одно-два предложения')
    expect(instructions).not.toContain('мастер')
    expect(instructions).toContain('без ролей')
    expect(instructions).not.toContain('Не отвечай на разговоры игроков')
  })

  it('пока гости не готовы — нейтральный статус и запрет «можно начинать»', () => {
    const roster = [
      entry({ clientId: 'm', name: 'Мастер', isMaster: true, percent: 100, hashOk: true, ready: true, playerId: 1 }),
      entry({
        clientId: 'g',
        name: 'Вася',
        percent: 40,
        etaSeconds: 90,
        playerId: 2,
      }),
    ]
    const instructions = lobbySpeechInstructions({
      kind: 'idle',
      packName: 'Демо',
      packSummary: 'Один раунд.',
      roster,
    })

    expect(lobbyEveryoneReady(roster)).toBe(false)
    expect(instructions).toContain('старт не обещай')
    expect(instructions).toContain('Ещё ждём: Вася.')
    expect(instructions).toContain('качает, 40%, ещё ~2 мин')
    expect(instructions).not.toContain('можно начинать')
  })

  it('когда все гости готовы — можно сказать про старт', () => {
    const roster = [
      entry({ clientId: 'm', name: 'Мастер', isMaster: true, percent: 100, hashOk: true, ready: true, playerId: 1 }),
      entry({
        clientId: 'g',
        name: 'Вася',
        percent: 100,
        hashOk: true,
        ready: true,
        playerId: 2,
      }),
    ]
    const instructions = lobbySpeechInstructions({
      kind: 'update',
      packName: 'Демо',
      packSummary: 'Один раунд.',
      roster,
    })

    expect(lobbyEveryoneReady(roster)).toBe(true)
    expect(instructions).toContain('Все готовы')
    expect(instructions).toContain('можно начинать')
    expect(lobbyRosterStatusLine(roster[1]!)).toContain('пакет сверен, готов')
  })
})

describe('настроение реплики лобби: монетка jokeCoin', () => {
  it('монетка решает, упоминать ли шутку в инструкции лобби', () => {
    const facts = { kind: 'idle' as const, packName: 'Демо', packSummary: 'Один раунд', roster: [] as RosterEntry[] }
    const original = jokeCoin.flip
    try {
      jokeCoin.flip = () => false
      expect(lobbySpeechInstructions(facts)).not.toContain('Настроение:')
      jokeCoin.flip = () => true
      expect(lobbySpeechInstructions(facts)).toContain('Настроение: можно добавить одну очень короткую добрую шутку')
    } finally {
      jokeCoin.flip = original
    }
  })
})
