import { describe, expect, it } from 'vitest'
import { derivePackPhase, packProgressLabel, stickyPackPhase } from './packProgress.ts'
import { ConferenceRoster } from './roster.ts'

describe('packProgressLabel phases', () => {
  it('показывает соединение, загрузку и сверку', () => {
    expect(packProgressLabel({ percent: 0, hashOk: false, ready: false, packPhase: 'connecting' })).toBe(
      'Устанавливаю соединение',
    )
    expect(
      packProgressLabel({
        percent: 42,
        hashOk: false,
        ready: false,
        packPhase: 'downloading',
        downloadBps: 120_000,
        etaSeconds: 40,
      }),
    ).toContain('Загрузка 42%')
    expect(packProgressLabel({ percent: 99, hashOk: false, ready: false, packPhase: 'verifying' })).toBe(
      'Сверка…',
    )
    expect(packProgressLabel({ percent: 100, hashOk: true, ready: false })).toBe('Пакет сверен')
    expect(packProgressLabel({ percent: 100, hashOk: true, ready: true })).toBe('Пакет сверен · готов')
  })

  it('не мигает «Устанавливаю соединение» при percent > 0', () => {
    expect(
      packProgressLabel({
        percent: 37,
        hashOk: false,
        ready: false,
        packPhase: 'connecting',
        downloadBps: 50_000,
        etaSeconds: 120,
      }),
    ).toContain('Загрузка 37%')
  })

  it('derivePackPhase учитывает pipe и sticky percent', () => {
    expect(derivePackPhase({ pipeState: 'connecting', percent: 0, hashOk: false, ready: false })).toBe(
      'connecting',
    )
    expect(derivePackPhase({ pipeState: 'open', percent: 10, hashOk: false, ready: false })).toBe(
      'downloading',
    )
    expect(
      derivePackPhase({ pipeState: 'connecting', percent: 25, hashOk: false, ready: false }),
    ).toBe('downloading')
    expect(
      derivePackPhase({
        pipeState: 'connecting',
        percent: 0,
        hashOk: false,
        ready: false,
        previousPhase: 'downloading',
      }),
    ).toBe('downloading')
    expect(derivePackPhase({ waitingMaster: true, percent: 0, hashOk: false, ready: false })).toBe('waiting')
    expect(derivePackPhase({ pipeState: 'failed', percent: 40, hashOk: false, ready: false })).toBe('failed')
  })

  it('stickyPackPhase не откатывает загрузку без явного percent: 0', () => {
    expect(
      stickyPackPhase({
        previous: 'downloading',
        next: 'connecting',
        percent: 40,
        hashOk: false,
        ready: false,
      }),
    ).toBe('downloading')
    expect(
      stickyPackPhase({
        previous: 'downloading',
        next: 'connecting',
        percent: 0,
        hashOk: false,
        ready: false,
      }),
    ).toBe('downloading')
    expect(
      stickyPackPhase({
        previous: 'downloading',
        next: 'connecting',
        percent: 0,
        hashOk: false,
        ready: false,
        percentExplicitlyZero: true,
      }),
    ).toBe('connecting')
  })
})

describe('roster packPhase sticky', () => {
  it('onState connecting не затирает прогресс и фазу загрузки', () => {
    const roster = new ConferenceRoster('master', 'Мастер')
    roster.upsertHello('guest', 'Мобилка')
    roster.updateProgress('guest', {
      percent: 40,
      packPhase: 'downloading',
      downloadBps: 80_000,
      etaSeconds: 90,
    })
    roster.updateProgress('guest', { packPhase: 'connecting' })
    expect(roster.get('guest')).toMatchObject({
      percent: 40,
      packPhase: 'downloading',
      downloadBps: 80_000,
      etaSeconds: 90,
    })
  })

  it('явный percent: 0 разрешает снова connecting (рестарт передачи)', () => {
    const roster = new ConferenceRoster('master', 'Мастер')
    roster.upsertHello('guest', 'Гость')
    roster.updateProgress('guest', { percent: 55, packPhase: 'downloading' })
    roster.updateProgress('guest', { percent: 0, packPhase: 'connecting' })
    expect(roster.get('guest')).toMatchObject({ percent: 0, packPhase: 'connecting' })
  })
})
