import { describe, expect, it } from 'vitest'
import { auctionAskCue, auctionCue, auctionWonCue, catCue, catStakeCue, specialListenerId, specialListening } from './controller.ts'
import type { GameContext, SpecialState } from './types.ts'

const special: SpecialState = {
  kind: 'cat', questionId: 'q', giverId: 1, recipientId: null, stakeOptions: [100, 500], stake: null, nominal: 200,
  order: [], passed: [], leaderId: null, bid: null, allIn: false, options: [], log: [], unclear: '',
  awayPlayerId: null, awayFrom: null, awayNextChooser: null,
}
const question = { id: 'q', themeId: 't', themeName: 'Кот', roundIndex: 0, value: 200, text: 'СЕКРЕТНЫЙ ВОПРОС', answers: ['ЭТАЛОН'],
  cat: { source: 'cat', theme: 'Звери', price: { kind: 'roundMinMax' }, knows: 'after', options: [100, 500] } }
const context = {
  players: [{ id: 1, name: 'Аня', score: 0 }, { id: 2, name: 'Боря', score: 0 }, { id: 3, name: 'Вася', score: 0 }],
  questions: [question], activeQuestionId: 'q', special,
} as unknown as GameContext

describe('реплики кота и аукциона', () => {
  it('кот: тему и вопрос до выбора не раскрывает, просит отдать', () => {
    const cue = catCue(context)
    expect(cue).toContain('Аня')
    expect(cue).toContain('кому отдать кота')
    expect(cue).not.toContain('Кому отдадите')
    expect(cue).not.toContain('СЕКРЕТНЫЙ ВОПРОС')
    expect(cue).not.toContain('ЭТАЛОН')
    expect(cue).toContain('Тему кота пока не называй')
  })
  it('кот на двоих — сразу называет получателя', () => {
    expect(catCue({ ...context, players: context.players.slice(0, 2), special: { ...special, recipientId: 2 } })).toContain('автоматически уходит игроку Боря')
  })
  it('ставка кота: тема и мин/макс', () => {
    const cue = catStakeCue({ ...context, special: { ...special, recipientId: 2 } })
    expect(cue).toContain('Звери')
    expect(cue).toContain('минимум 100 или максимум 500')
  })
  it('аукцион: авто-ставка, перекуп, итог', () => {
    const auction = { ...special, kind: 'auction' as const }
    expect(auctionCue({ ...context, special: { ...auction, bid: 200 } })).toContain('торгов нет')
    const ask = auctionAskCue({ ...context, special: { ...auction, recipientId: 3, leaderId: 2, bid: 400 } })
    expect(ask).toContain('назови текущую ставку 400, скажи, что она у игрока Боря')
    expect(ask).toContain('«Вася, у Бори уже четыреста')
    expect(ask).toContain('«Васе решать')
    expect(ask).toContain('лидирует Боря')
    expect(ask).toContain('реальные имена склоняй сама')
    expect(ask).toContain('Примеры стиля')
    expect(ask).toContain('не копируй')
    expect(ask.match(/«[^»]+»/g)?.length).toBeGreaterThanOrEqual(4)
    expect(ask).not.toContain('перекупаете?»')
    expect(auctionWonCue({ ...context, special: { ...auction, leaderId: 2, bid: 400 } })).toContain('уходит игроку Боря за 400')
    expect(auctionWonCue({ ...context, special: { ...auction, leaderId: 2, bid: 400 } })).not.toContain('СЕКРЕТНЫЙ')
  })
  it('кого слушаем', () => {
    expect(specialListenerId('cat.picking', context)).toBe(1)
    expect(specialListenerId('cat.staking.listening', { ...context, special: { ...special, recipientId: 3 } })).toBe(3)
    expect(specialListenerId('auction.listening', { ...context, special: { ...special, kind: 'auction', recipientId: 2 } })).toBe(2)
    expect(specialListenerId('auction.won', { ...context, special: { ...special, kind: 'auction', recipientId: 2 } })).toBeNull()
    expect(specialListening('cat.picking')).toBe(true)
    expect(specialListening('cat.placed')).toBe(false)
  })
})

import { sessionTools, toolPurposes } from '../realtime/tools.ts'
import { catRecipientInstructions, specialBidInstructions } from './controller.ts'

describe('инструменты запасного разбора', () => {
  it('у каждого инструмента сессии есть назначение', () => {
    for (const tool of sessionTools) expect(toolPurposes[tool.name], tool.name).toBeTruthy()
    expect(toolPurposes.selectCatRecipient).toBe('catPick')
    expect(toolPurposes.resolveSpecialBid).toBe('specialBid')
  })
  it('инструкции: только кандидаты и варианты экрана', () => {
    const cat = catRecipientInstructions('Анюте', [{ id: 1, name: 'Анна' }, { id: 3, name: 'Вера' }])
    expect(cat).toContain('1: Анна\n3: Вера')
    expect(cat).toContain('playerId — только id из списка')
    const bid = specialBidInstructions('пас', [{ kind: 'pass' }, { kind: 'stake', amount: 300 }, { kind: 'allIn', amount: 900 }])
    expect(bid).toContain('- пас: choice=pass')
    expect(bid).toContain('- 300: choice=amount, amount=300')
    expect(bid).toContain('- ва-банк 900: choice=allIn')
  })
})

import { echoesChoicePrompt, optionsPrompt, playersPrompt } from './choicePrompt.ts'
import { answerPromptFor, finalBetInstructions, specialPrompt } from './controller.ts'

describe('подсказки распознаванию — как каталог ячеек', () => {
  it('имена кандидатов и варианты ставок в фигурных скобках, суммы со словами', () => {
    expect(playersPrompt(['Анна', 'Вера'])).toBe('{Анна; Вера}')
    expect(optionsPrompt([{ kind: 'pass' }, { kind: 'stake', amount: 300 }, { kind: 'allIn', amount: 900 }])).toBe('{пас; 300 триста; ва-банк 900 девятьсот}')
    expect(optionsPrompt([{ kind: 'min', amount: 100 }, { kind: 'max', amount: 500 }])).toBe('{минимум 100 сто; максимум 500 пятьсот}')
  })
  it('предел длины 1024 как у каталога', () => {
    const many = Array.from({ length: 300 }, (_, i) => `Игрок номер ${i}`)
    expect(playersPrompt(many).length).toBeLessThanOrEqual(1024)
  })
  it('specialPrompt по узлу: без выбравшего; ставка мин/макс; варианты торгов', () => {
    expect(specialPrompt('cat.picking', context)).toBe('{Боря; Вася}')
    expect(specialPrompt('cat.clarifying', context)).toBe('{Боря; Вася}')
    expect(specialPrompt('cat.staking.listening', { ...context, special: { ...special, recipientId: 2 } })).toBe('{минимум 100 сто; максимум 500 пятьсот}')
    expect(specialPrompt('auction.listening', { ...context, special: { ...special, kind: 'auction', options: [{ kind: 'pass' }, { kind: 'allIn', amount: 700 }] } })).toBe('{пас; ва-банк 700 семьсот}')
  })
  it('эхо подсказки имён отфильтровывается тем же echoesChoicePrompt', () => {
    const prompt = playersPrompt(['Анна', 'Вера', 'Борис'])
    expect(echoesChoicePrompt('Анна; Вера; Борис', prompt)).toBe(true)
    expect(echoesChoicePrompt('отдаю Вере', prompt)).toBe(false)
  })
  it('вопрос с вариантами: в подсказке все варианты, не только эталон', () => {
    const q = { id: 'c', themeId: 't', themeName: 'Выбор', roundIndex: 0, value: 100, text: '?', answers: ['D'],
      choices: [{ label: 'A', text: 'Индиана', media: [] }, { label: 'D', text: 'Звёздные войны', media: [] }] }
    const prompt = answerPromptFor({ ...context, questions: [q], activeQuestionId: 'c' } as unknown as GameContext)
    expect(prompt).toContain('A Индиана')
    expect(prompt).toContain('D Звёздные войны')
  })
  it('ставка финала: модель получает предел денег', () => {
    expect(finalBetInstructions('ну половину', 800)).toContain('от 0 до 800')
  })
})
