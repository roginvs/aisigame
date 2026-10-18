import { describe, expect, it, vi } from 'vitest'
import { createSpeechLevels } from './speechLevel.ts'

function timed() {
  let now = 0
  return {
    now: () => now,
    tick: (ms = 200) => {
      now += ms
      return now
    },
  }
}

describe('createSpeechLevels — устойчивая речь по уровням', () => {
  it('реплика ≥1 с звуком подряд даёт одно уведомление, речь дальше не повторяет его', () => {
    const clock = timed()
    const onEpisode = vi.fn()
    const levels = createSpeechLevels(onEpisode, clock.now)
    // Кадры раз в 200 мс: шестой кадр — уже секунда речи.
    for (let i = 0; i < 6; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).toHaveBeenCalledTimes(1)
    levels.dispose()
  })

  it('короткий звук и пауза в речи не считаются, тянут счёт до секунды', () => {
    const clock = timed()
    const onEpisode = vi.fn()
    const levels = createSpeechLevels(onEpisode, clock.now)
    // 400 мс речи — ниже порога устойчивости.
    for (let i = 0; i < 2; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).not.toHaveBeenCalled()
    // Тихий кадр внутри речи: счёт продолжается.
    clock.tick()
    levels.note('p1', 0.01)
    for (let i = 0; i < 4; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).toHaveBeenCalledTimes(1)
    levels.dispose()
  })

  it('тишина длиннее паузы рвёт счёт: новой реплике нужны свои 1 с', () => {
    const clock = timed()
    const onEpisode = vi.fn()
    const levels = createSpeechLevels(onEpisode, clock.now)
    for (let i = 0; i < 6; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).toHaveBeenCalledTimes(1)
    // Тишина: кадр 0 уровня дважды с большим промежутком.
    levels.note('p1', 0)
    clock.tick(1500)
    levels.note('p1', 0)
    // Речь началась заново: треть секунды недостаточно.
    for (let i = 0; i < 2; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    expect(onEpisode).toHaveBeenCalledTimes(2)
    levels.dispose()
  })

  it('конец реплики: одна тишина-разрыв даёт один конец с длительностью, короткий шум без конца', () => {
    const clock = timed()
    const onEpisode = vi.fn()
    const onEpisodeEnd = vi.fn()
    const levels = createSpeechLevels(onEpisode, clock.now, onEpisodeEnd)
    for (let i = 0; i < 6; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    // Реплика закончилась: кадры тихие с разрывом больше паузы.
    clock.tick(700)
    levels.note('p1', 0)
    expect(onEpisodeEnd).toHaveBeenCalledTimes(1)
    expect(onEpisodeEnd).toHaveBeenCalledWith('p1', 1000)
    // Реплика короче секунды устойчивости (не `fired`) — конца не было.
    clock.tick()
    levels.note('p2', 0.5)
    clock.tick(700)
    clock.tick()
    levels.note('p2', 0)
    expect(onEpisodeEnd).toHaveBeenCalledTimes(1)
    expect(onEpisode).toHaveBeenCalledTimes(1)
    levels.dispose()
  })

  it('clear участника отдаёт конец реплики тоже', () => {
    const clock = timed()
    const onEpisodeEnd = vi.fn()
    const levels = createSpeechLevels(() => {}, clock.now, onEpisodeEnd)
    for (let i = 0; i < 6; i += 1) {
      clock.tick()
      levels.note('p1', 0.5)
    }
    levels.clear('p1')
    expect(onEpisodeEnd).toHaveBeenCalledTimes(1)
    expect(onEpisodeEnd).toHaveBeenCalledWith('p1', 1000)
    levels.dispose()
  })

  it('без участника уведомлений нет', () => {
    const clock = timed()
    const onEpisode = vi.fn()
    const levels = createSpeechLevels(onEpisode, clock.now)
    for (let i = 0; i < 10; i += 1) {
      clock.tick()
      levels.note('', 0.5)
    }
    expect(onEpisode).not.toHaveBeenCalled()
    levels.dispose()
  })
})
