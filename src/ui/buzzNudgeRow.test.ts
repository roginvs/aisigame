import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConferencePlayersRow } from './ConferencePlayersRow.tsx'

function row(nudgePlayerIds: readonly number[], falseStarts: Record<number, number> = {}) {
  const noop = () => undefined
  return renderToStaticMarkup(createElement(ConferencePlayersRow, {
    mode: 'match', tiles: [], bindVideo: noop, selfClientId: 'a', roster: [],
    players: [{ id: 1, name: 'Вася', score: 0, clientId: 'a' }, { id: 2, name: 'Маша', score: 0, clientId: 'b' }],
    hasMatchData: true, path: 'reading.armed', activePlayerId: null, chooserId: 1, missedIds: [],
    falseStarts, penaltyClock: Date.now(), paused: false, buttonsOpen: true, canFalseStart: false, earlyLive: true,
    onBuzz: noop, nudgePlayerIds, layout: true,
  }))
}

describe('кнопка: локальная вспышка «жми»', () => {
  it('мигает только кнопка своего игрока, без смены размера (класс + переменные анимации)', () => {
    const html = row([1])
    expect(html.match(/buzz-nudge/g)).toHaveLength(1)
    expect(html).toContain('--nudge-ms:450ms')
    expect(row([])).not.toContain('buzz-nudge')
  })

  it('во время фальстарта не мигает', () => {
    expect(row([1], { 1: Date.now() })).not.toContain('buzz-nudge')
  })
})
