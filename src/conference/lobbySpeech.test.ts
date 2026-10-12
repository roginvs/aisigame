import { describe, expect, it } from 'vitest'
import {
  lobbyEveryoneReady,
  lobbyRosterStatusLine,
  lobbySpeechInstructions,
} from './lobbySpeech.ts'
import type { RosterEntry } from './roster.ts'

function entry(patch: Partial<RosterEntry> & Pick<RosterEntry, 'clientId' | 'name'>): RosterEntry {
  return {
    playerId: null,
    percent: 0,
    downloadBps: null,
    etaSeconds: null,
    ready: false,
    hashOk: false,
    lastSeen: 0,
    stale: false,
    hidden: false,
    isMaster: false,
    ...patch,
  }
}

describe('lobbySpeechInstructions', () => {
  it('разрешает коротко участвовать в разговоре игроков без длинного монолога', () => {
    const instructions = lobbySpeechInstructions({
      kind: 'idle',
      packName: 'Демо',
      packSummary: 'Один раунд.',
      roster: [],
    })

    expect(instructions).toContain('можешь коротко и естественно его прокомментировать, ответить или поддержать беседу')
    expect(instructions).toContain('обычно два коротких предложения')
    expect(instructions).toContain('можно коротко подхватить разговор')
    expect(instructions).toContain('контекст, не скрипт')
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
    expect(instructions).toContain('не говори, что можно начинать')
    expect(instructions).toContain('Ещё ждём: Вася.')
    expect(instructions).toContain('качает (40%, ещё ~2 мин)')
    expect(instructions).not.toContain('Все гости в комнате скачали пакет и готовы')
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
    expect(instructions).toContain('Все гости в комнате скачали пакет и готовы')
    expect(instructions).toContain('можно начинать')
    expect(lobbyRosterStatusLine(roster[1]!)).toContain('пакет сверен, готов')
  })
})
