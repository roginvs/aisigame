import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { displayLevel, getModelLevels, resetModelLevels, setModelLevels } from './modelLevels.ts'
import { noteTileLevel, resetTileLevels } from './tileLevels.ts'
import { ConferenceVideoTile } from '../ui/ConferenceVideoStrip.tsx'

afterEach(() => {
  resetModelLevels()
  resetTileLevels()
})

describe('modelLevels', () => {
  it('displayLevel: усиление ×4, потолок 1, округление', () => {
    expect(displayLevel(0)).toBe(0)
    expect(displayLevel(0.05)).toBe(0.2)
    expect(displayLevel(0.9)).toBe(1)
    expect(displayLevel(Number.NaN)).toBe(0)
  })

  it('кадр участника рисует уровень речи (tileLevels), не долю микса модели', () => {
    setModelLevels({ total: 0.5, byParticipant: { irina: 0.9 } })
    expect(getModelLevels().total).toBe(0.5)
    noteTileLevel('irina', 0.44)
    const html = renderToStaticMarkup(createElement(ConferenceVideoTile, {
      tile: { id: 'irina', name: 'Ирина', isLocal: false, micLive: true, cameraOn: false, speaking: false },
      bindVideo: () => undefined,
    }))
    expect(html).toContain('scaleX(0.44)')
    expect(html).toContain('Уровень речи')
  })
})
