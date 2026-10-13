import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AirStatus } from './airStatus.tsx'

describe('AirStatus', () => {
  it('в шапке только связь: без значков микрофона и речи ведущей', () => {
    const html = renderToStaticMarkup(createElement(AirStatus, { link: { connection: 'connected', mic: 'live', host: 'speaking' } }))
    expect(html).toContain('data-air="link"')
    expect(html).not.toContain('data-air="mic"')
    expect(html).not.toContain('data-air="host"')
  })
})
