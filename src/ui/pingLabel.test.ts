import { describe, expect, it } from 'vitest'
import { pingLabel } from './ConferenceVideoStrip.tsx'

describe('pingLabel', () => {
  it('«42 ms», пусто без замера', () => {
    expect(pingLabel(42)).toBe('42 ms')
    expect(pingLabel(41.6)).toBe('42 ms')
    expect(pingLabel(0)).toBe('0 ms')
    expect(pingLabel(null)).toBe('')
    expect(pingLabel(undefined)).toBe('')
    expect(pingLabel(-5)).toBe('')
  })
})
