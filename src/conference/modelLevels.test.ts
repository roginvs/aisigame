import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { displayLevel, getModelLevels, resetModelLevels, sameModelLevels, setModelLevels, validModelLevels } from './modelLevels.ts'
import { isConferenceMessage } from './messages.ts'
import { ConferenceVideoTile } from '../ui/ConferenceVideoStrip.tsx'

afterEach(() => resetModelLevels())

describe('modelLevels', () => {
  it('displayLevel: усиление ×4, потолок 1, округление', () => {
    expect(displayLevel(0)).toBe(0)
    expect(displayLevel(0.05)).toBe(0.2)
    expect(displayLevel(0.9)).toBe(1)
    expect(displayLevel(Number.NaN)).toBe(0)
  })

  it('sameModelLevels: отсутствующий ключ = 0', () => {
    expect(sameModelLevels({ total: 0, byParticipant: { a: 0 } }, { total: 0, byParticipant: {} })).toBe(true)
    expect(sameModelLevels({ total: 0.1, byParticipant: {} }, { total: 0, byParticipant: {} })).toBe(false)
  })

  it('сообщение modelLevels проходит проверку только с уровнями 0..1', () => {
    expect(isConferenceMessage({ type: 'modelLevels', authorityToken: 't', levels: { total: 0.3, byParticipant: { a: 0.3 } } })).toBe(true)
    expect(isConferenceMessage({ type: 'modelLevels', authorityToken: 't', levels: { total: 2, byParticipant: {} } })).toBe(false)
    expect(validModelLevels({ total: 0, byParticipant: { a: -1 } })).toBe(false)
  })

  it('кадр участника рисует его вклад в поток модели из общих уровней', () => {
    setModelLevels({ total: 0.5, byParticipant: { irina: 0.4 } })
    expect(getModelLevels().total).toBe(0.5)
    const html = renderToStaticMarkup(createElement(ConferenceVideoTile, {
      tile: { id: 'irina', name: 'Ирина', isLocal: false, micLive: true, cameraOn: false, speaking: false },
      bindVideo: () => undefined,
    }))
    expect(html).toContain('scaleX(0.4)')
  })
})
