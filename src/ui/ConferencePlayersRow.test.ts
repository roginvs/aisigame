import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConferencePlayersRow } from './ConferencePlayersRow.tsx'
import type { RosterEntry } from '../conference/roster.ts'

function entry(partial: Partial<RosterEntry> & Pick<RosterEntry, 'clientId' | 'name' | 'isMaster'>): RosterEntry {
  return {
    playerId: null,
    percent: 0,
    downloadBps: null,
    etaSeconds: null,
    packPhase: 'connecting',
    ready: false,
    hashOk: false,
    lastSeen: Date.now(),
    stale: false,
    hidden: false,
    ...partial,
  }
}

describe('ConferencePlayersRow lobby', () => {
  it('shows pack progress and ready labels for guests, not clipped away', () => {
    const html = renderToStaticMarkup(
      createElement(ConferencePlayersRow, {
        mode: 'lobby',
        tiles: [],
        bindVideo: vi.fn(),
        selfClientId: 'master',
        roster: [
          entry({ clientId: 'master', name: 'Вася', isMaster: true, percent: 100, ready: true, hashOk: true }),
          entry({
            clientId: 'g1',
            name: 'kekeke',
            isMaster: false,
            percent: 100,
            packPhase: 'ready',
            ready: true,
            hashOk: true,
          }),
          entry({
            clientId: 'g2',
            name: 'Мобилка',
            isMaster: false,
            percent: 42,
            packPhase: 'downloading',
            downloadBps: 120_000,
            etaSeconds: 40,
            ready: false,
            hashOk: false,
          }),
          entry({
            clientId: 'g3',
            name: 'Ира',
            isMaster: false,
            percent: 100,
            packPhase: 'verified',
            ready: false,
            hashOk: true,
          }),
          entry({
            clientId: 'g4',
            name: 'Петя',
            isMaster: false,
            percent: 0,
            packPhase: 'connecting',
            ready: false,
            hashOk: false,
          }),
        ],
        players: [],
        hasMatchData: true,
        path: 'lobby',
        activePlayerId: null,
        chooserId: 1,
        missedIds: [],
        falseStarts: {},
        penaltyClock: Date.now(),
        paused: false,
        buttonsOpen: false,
        canFalseStart: false,
        earlyLive: false,
        onBuzz: vi.fn(),
        layout: true,
      }),
    )

    expect(html).toContain('Пакет сверен · готов')
    expect(html).toContain('Пакет сверен')
    expect(html).toContain('Загрузка 42%')
    expect(html).toContain('Устанавливаю соединение')
    expect(html).toContain('roster-tag">мастер')
    expect(html).toContain('player-lobby-progress is-ready')
    // У мастера нет полоски прогресса гостя, только spacer.
    expect(html).toContain('player-lobby-spacer')
    // Пять карточек: мастер + 4 гостя.
    expect(html.match(/conference-player(?!s)/g)?.length).toBe(5)
  })

  it('в партии помечает stale-игрока серым классом из roster', () => {
    const html = renderToStaticMarkup(
      createElement(ConferencePlayersRow, {
        mode: 'match',
        tiles: [],
        bindVideo: vi.fn(),
        selfClientId: 'master',
        roster: [
          entry({ clientId: 'master', name: 'Мастер', isMaster: true, playerId: 1 }),
          entry({ clientId: 'guest', name: 'Гость', isMaster: false, playerId: 2, stale: true }),
        ],
        players: [
          { id: 1, name: 'Мастер', score: 0, clientId: 'master' },
          { id: 2, name: 'Гость', score: 100, clientId: 'guest' },
        ],
        hasMatchData: true,
        path: 'choosing.listening',
        activePlayerId: null,
        chooserId: 1,
        missedIds: [],
        falseStarts: {},
        penaltyClock: Date.now(),
        paused: false,
        buttonsOpen: false,
        canFalseStart: false,
        earlyLive: false,
        onBuzz: vi.fn(),
        layout: true,
      }),
    )
    expect(html).toContain('display-only stale')
    expect(html).toContain('нет связи')
    // Имя один раз в player-meta, не в кадре и не на кнопке.
    expect(html).toContain('камера выкл.')
    expect(html).not.toContain('video-name')
    expect(html.match(/>Гость</g)?.length).toBe(1)
    // Выбор ячейки: кнопка без «Жмите».
    expect(html).not.toContain('>Жмите<')
    expect(html).toContain('выбирайте вопрос')
  })
})
