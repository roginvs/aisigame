import { describe, expect, it } from 'vitest'
import { matchConferenceTile } from './conferenceTileMatch.ts'

const tiles = [
  {
    id: 'local',
    name: 'Маша',
    isLocal: true,
    micLive: true,
    cameraOn: true,
    speaking: false,
  },
  {
    id: 'r1',
    name: 'Вася',
    isLocal: false,
    micLive: false,
    cameraOn: false,
    speaking: true,
  },
]

describe('matchConferenceTile', () => {
  it('prefers the local tile for the own clientId', () => {
    expect(
      matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'me', name: 'Маша' })?.id,
    ).toBe('local')
  })

  it('matches remotes by display name', () => {
    expect(
      matchConferenceTile(tiles, { selfClientId: 'me', clientId: 'other', name: 'Вася' })?.id,
    ).toBe('r1')
  })
})
