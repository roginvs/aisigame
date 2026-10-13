import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GameContext, Question, SpecialState } from '../game/types.ts'
import { SpecialPanel } from './SpecialPanel.tsx'
import { specialPanelPath } from './specialPanelPath.ts'

const question = {
  id: 'q1', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 200, text: 'Вопрос', answers: ['ответ'],
  cat: { source: 'v4', theme: 'Котики', price: { kind: 'fixed', value: 300 }, knows: 'after', options: [300] },
} as unknown as Question
const special: SpecialState = {
  kind: 'cat', questionId: 'q1', giverId: 1, recipientId: null, stakeOptions: [300], stake: null, nominal: 300,
  order: [], passed: [], leaderId: null, bid: null, allIn: false, options: [], log: [], unclear: '',
  awayPlayerId: null, awayFrom: null, awayNextChooser: null,
}
const context = {
  questions: [question],
  players: [{ id: 1, name: 'Аня', score: 0 }, { id: 2, name: 'Борис', score: 0 }, { id: 3, name: 'Вера', score: 900 }],
  special,
} as unknown as GameContext

const render = (path: string, ctx: GameContext, canAct = () => true) =>
  renderToStaticMarkup(createElement(SpecialPanel, { context: ctx, path, canAct, onPick: () => {} }))

describe('SpecialPanel', () => {
  it('кот до выбора: картинка, тема скрыта, кнопки другим игрокам', () => {
    const html = render('cat.picking', context)
    expect(html).toContain('images/cat.svg')
    expect(html).not.toContain('Котики')
    expect(html).toContain('>Борис<')
    expect(html).toContain('>Вера<')
    expect(html).not.toContain('>Аня</button>')
  })
  it('чужой экран кнопок не видит', () => {
    expect(render('cat.picking', context, () => false)).not.toContain('<button')
  })
  it('после выбора видна тема кота', () => {
    const html = render('cat.placed', { ...context, special: { ...special, recipientId: 2, stake: 300 } })
    expect(html).toContain('Котики')
    expect(html).not.toContain('images/cat.svg')
  })
  it('аукцион: лидер, ставка, кнопки торга и лог', () => {
    const html = render('auction.asking', {
      ...context,
      special: {
        ...special, kind: 'auction', recipientId: 3, leaderId: 2, bid: 400,
        options: [{ kind: 'pass' }, { kind: 'stake', amount: 500 }, { kind: 'allIn', amount: 900 }], log: ['Борис: 400'],
      },
    })
    expect(html).toContain('images/auction.svg')
    expect(html).toContain('Борис — 400')
    expect(html).toContain('Вера решает, перекупать ли')
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).toContain('Борис: 400')
  })
  it('ожидание отошедшего', () => {
    expect(render('specialAway', { ...context, special: { ...special, awayPlayerId: 2 } })).toContain('Ждём игрока Борис')
  })
  it('панель только на узлах кота/аукциона', () => {
    expect(specialPanelPath('cat.picking', context)).toBe(true)
    expect(specialPanelPath('answering.waiting', context)).toBe(false)
    expect(specialPanelPath('cat.picking', { ...context, special: null } as GameContext)).toBe(false)
  })
})
