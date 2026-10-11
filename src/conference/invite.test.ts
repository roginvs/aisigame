import { describe, expect, it } from 'vitest'
import { buildInviteUrl, parseInvite } from './invite.ts'

describe('buildInviteUrl', () => {
  it('GitHub Pages с base /aisigame/', () => {
    const href = buildInviteUrl({
      origin: 'https://roginvs.github.io',
      base: '/aisigame/',
      roomId: 'ROOM',
      jitsiBase: 'https://fallout-nevada.ru/jitsi',
    })
    expect(href).toBe(
      'https://roginvs.github.io/aisigame/?join=ROOM&jitsi=https%3A%2F%2Ffallout-nevada.ru%2Fjitsi',
    )
    expect(href).not.toContain('mock=1')
  })

  it('локальный dev заменяет на публичный туннель', () => {
    const href = buildInviteUrl({
      origin: 'http://127.0.0.1:5173',
      base: '/',
      roomId: 'ROOM',
      jitsiBase: 'https://fallout-nevada.ru/jitsi',
    })
    expect(href).toBe(
      'https://dev.fallout-nevada.ru/?join=ROOM&jitsi=https%3A%2F%2Ffallout-nevada.ru%2Fjitsi',
    )
  })
})

describe('parseInvite', () => {
  it('читает join и jitsi из query', () => {
    expect(
      parseInvite('?join=uuid-here&jitsi=https%3A%2F%2Ffallout-nevada.ru%2Fjitsi'),
    ).toEqual({
      roomId: 'uuid-here',
      jitsiBase: 'https://fallout-nevada.ru/jitsi',
      transport: 'jitsi',
    })
  })

  it('без join или jitsi — null', () => {
    expect(parseInvite('?join=only')).toBeNull()
    expect(parseInvite('?jitsi=https%3A%2F%2Fx')).toBeNull()
    expect(parseInvite('')).toBeNull()
  })

  it('не зависит от path base — только search', () => {
    const parsed = parseInvite('?join=R&jitsi=https%3A%2F%2Fhost%2Fjitsi')
    expect(parsed?.roomId).toBe('R')
  })

  it('переносит явный локальный transport, не связывая его с моделью', () => {
    const href = buildInviteUrl({
      origin: 'http://127.0.0.1:5173',
      base: '/',
      roomId: 'ROOM',
      jitsiBase: 'https://example.test/jitsi',
      transport: 'broadcast',
    })
    expect(new URL(href).searchParams.get('transport')).toBe('broadcast')
    expect(parseInvite(new URL(href).search)).toMatchObject({ transport: 'broadcast' })
  })
})
