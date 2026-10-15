import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { displayLevel, getModelLevels, resetModelLevels, setModelLevels } from './modelLevels.ts'
import { ConferenceVideoTile } from '../ui/ConferenceVideoStrip.tsx'

afterEach(() => resetModelLevels())

describe('modelLevels', () => {
  it('displayLevel: усиление ×4, потолок 1, округление', () => {
    expect(displayLevel(0)).toBe(0)
    expect(displayLevel(0.05)).toBe(0.2)
    expect(displayLevel(0.9)).toBe(1)
    expect(displayLevel(Number.NaN)).toBe(0)
  })

  it('кадр участника рисует его вклад в поток модели из уровней мастера', () => {
    setModelLevels({ total: 0.5, byParticipant: { irina: 0.4 } })
    expect(getModelLevels().total).toBe(0.5)
    const html = renderToStaticMarkup(createElement(ConferenceVideoTile, {
      tile: { id: 'irina', name: 'Ирина', isLocal: false, micLive: true, cameraOn: false, speaking: false },
      bindVideo: () => undefined,
    }))
    expect(html).toContain('scaleX(0.4)')
  })
})
