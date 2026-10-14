import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConferenceTile } from '../conference/media.ts'
import { ConferenceVideoTile } from './ConferenceVideoStrip.tsx'

const tile = (patch: Partial<ConferenceTile>): ConferenceTile => ({ id: 'p', name: 'Вася', isLocal: false, micLive: true, cameraOn: true, speaking: false, ...patch })
const html = (t: ConferenceTile) => renderToStaticMarkup(createElement(ConferenceVideoTile, { tile: t, bindVideo: () => {} }))

describe('зеркало видео', () => {
  it('своя фронтальная (или неизвестная) — зеркалится', () => {
    expect(html(tile({ isLocal: true, mirror: true }))).toContain('mirrored')
    expect(html(tile({ isLocal: true }))).toContain('mirrored')
  })
  it('своя тыловая — не зеркалится', () => {
    expect(html(tile({ isLocal: true, mirror: false }))).not.toContain('mirrored')
  })
  it('чужая — никогда, даже с флагом', () => {
    expect(html(tile({ isLocal: false, mirror: true }))).not.toContain('mirrored')
  })
})
