import { describe, expect, it } from 'vitest'
import { buildCommit } from '../buildInfo.ts'
import { masterBuildMismatchMessage } from './buildMatch.ts'

describe('masterBuildMismatchMessage', () => {
  it('молчит при том же commit', () => {
    expect(masterBuildMismatchMessage(buildCommit())).toBeNull()
  })

  it('пишет обе версии при чужом или пустом commit', () => {
    const mine = buildCommit()
    expect(masterBuildMismatchMessage('zzz')).toBe(
      `Версия не совпадает с мастером: у вас ${mine}, у мастера zzz. Обновите страницу и зайдите снова.`,
    )
    expect(masterBuildMismatchMessage(undefined)).toBe(
      `Версия не совпадает с мастером: у вас ${mine}, у мастера неизвестна. Обновите страницу и зайдите снова.`,
    )
  })
})
