import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { hostInstructions } from '../config.ts'
import { STAGE_WORDS } from '../debug/stageWords.ts'
import { getTrace, pushHostLine } from '../debug/trace.ts'
import { lobbySpeechInstructions } from '../conference/lobbySpeech.ts'
import type { RosterEntry } from '../conference/roster.ts'
import { isolatedCue, spokenPayload } from '../realtime/speechMatch.ts'
import * as cues from './controller.ts'
import { gameMachine } from './machine.ts'
import type { AnnounceKind, GameContext, Question, QuestionPack, SpecialState } from './types.ts'

/** Стоп-лист: в подсказках модели этих слов быть не должно (сам список в подсказки не попадает). */
const STOP = STAGE_WORDS

const base = { roundIndex: 0, text: 'Вопрос?', answers: ['Ответ'] }
const pack: QuestionPack = {
  name: 'Пакет',
  rounds: [{ index: 0, name: 'Первый', kind: 'normal' }, { index: 1, name: 'Финал', kind: 'final' }],
  questions: [
    { ...base, id: 'q', themeId: 't', themeName: 'Тема', value: 100 },
    { ...base, id: 'q2', themeId: 't', themeName: 'Тема', value: 200 },
    { ...base, id: 'f', roundIndex: 1, themeId: 'f', themeName: 'Финал', value: 0 },
  ] satisfies Question[],
  warnings: [],
}

function ctx(): GameContext {
  const actor = createActor(gameMachine).start()
  actor.send({ type: 'START_GAME', pack, players: [{ id: 1, name: 'Боря', score: 300 }, { id: 2, name: 'Маша', score: -100 }, { id: 3, name: 'Игрок 3', score: 0 }] })
  const context = actor.getSnapshot().context
  actor.stop()
  return { ...context, activeQuestionId: 'q', activePlayerId: 1, chooserId: 2, falseStarts: { 1: 1, 2: 2 }, clarifyReason: 'Боря отключился' }
}

const special: SpecialState = {
  kind: 'auction', questionId: 'q', giverId: 1, recipientId: 2, stakeOptions: [100, 500], stake: null, nominal: 100,
  order: [1, 2, 3], passed: [], leaderId: 1, bid: 400, allIn: true, options: [], log: [], unclear: 'неясно',
  awayPlayerId: 3, awayFrom: 'bidding', awayNextChooser: null,
}

function roster(): RosterEntry[] {
  const entry = (name: string, extra: Partial<RosterEntry>): RosterEntry => ({
    clientId: name, name, playerId: 1, percent: 40, downloadBps: 1000, etaSeconds: 30, packPhase: 'loading' as RosterEntry['packPhase'],
    ready: false, hashOk: false, lastSeen: 0, stale: false, hidden: false, isMaster: false, ...extra,
  })
  return [entry('Мастер', { isMaster: true, hashOk: true, ready: true }), entry('Гость', {}), entry('Готовый', { hashOk: true, ready: true, percent: 100 })]
}

function allCues(): Array<[string, string]> {
  const c = ctx()
  const cat = { ...c, special: { ...special, kind: 'cat' as const, recipientId: null, bid: null, allIn: false } }
  const catTo = { ...cat, special: { ...cat.special, recipientId: 3 }, idleOutcome: { kind: 'catPick' as const, fromId: 1, toId: 3, waitedMs: 30_000 } }
  const auction = { ...c, special, idleOutcome: { kind: 'auction' as const, fromId: 3, toId: null, waitedMs: 20_000 } }
  const idle = (kind: 'choosing' | 'catPick' | 'catStake' | 'auction', base: GameContext) => ({ ...base, idle: { kind, stage: 2, elapsedMs: 30_000, since: 0, carry: false } })
  const list: Array<[string, string]> = [
    ['host', hostInstructions],
    ['isolated', isolatedCue(cues.falseStartInstructions(c), { purpose: 'x', turn: 1, take: 1 }).instructions],
    ['mutedMic', cues.mutedMicCue('Боря')],
    ['mutedAnswer', cues.mutedAnswerMicCue('Боря')],
    ['handoff', cues.chooserHandoffCue(c)],
    ['handoffIdle', cues.chooserHandoffCue({ ...c, idleOutcome: { kind: 'choosing', fromId: 1, toId: 2, waitedMs: 40_000 } })],
    ['handoffIdleSame', cues.chooserHandoffCue({ ...c, idleOutcome: { kind: 'choosing', fromId: 1, toId: 1, waitedMs: 40_000 } })],
    ['welcome', cues.welcomeInstructions(c)],
    ['summary', cues.roundSummaryInstructions(c)],
    ['bridge', cues.bridgeInstructions(c)],
    ['falseStart', cues.falseStartInstructions(c)],
    ['idleChoosing', cues.idleNudgeCue('choosing.listening', idle('choosing', c))],
    ['idleCat', cues.idleNudgeCue('cat.picking', idle('catPick', cat))],
    ['idleStake', cues.idleNudgeCue('cat.staking.listening', idle('catStake', catTo))],
    ['idleAuction', cues.idleNudgeCue('auction.listening', idle('auction', auction))],
    ['idleAuto', cues.idleAutoCue({ ...catTo, idleOutcome: { kind: 'catStake', fromId: 3, toId: 3, waitedMs: 20_000, stake: 100 } })],
    ['cat', cues.catCue(cat)],
    ['catClarify', cues.catClarifyCue(cat)],
    ['catStake', cues.catStakeCue(catTo)],
    ['catStakeClarify', cues.catStakeClarifyCue(catTo)],
    ['auction', cues.auctionCue(auction)],
    ['auctionAsk', cues.auctionAskCue(auction)],
    ['auctionClarify', cues.auctionClarifyCue(auction)],
    ['auctionWon', cues.auctionWonCue(auction)],
    ['away', cues.specialAwayCue(auction)],
    ['awayAnnounce', cues.awayAnnounceCue(auction)],
    ['finished', cues.finishedInstructions(c)],
  ]
  for (const kind of ['correct', 'incorrect', 'silence', 'nobody', 'unclear', 'repeat', 'away'] satisfies AnnounceKind[]) {
    list.push([`announce-${kind}`, cues.announceInstructions({ ...c, announceKind: kind })])
  }
  const appeal = { questionId: 'q', windowId: 1, startedAt: 0, remainingMs: 0, activePlayerId: 1 }
  list.push(['appeal', cues.announceInstructions({ ...c, announceKind: 'correct', appeal: appeal as never, outcomes: { q: { 1: { amount: 100, previous: -100 } } } as never })])
  for (const kind of ['opened', 'update', 'idle'] as const) {
    list.push([`lobby-${kind}`, lobbySpeechInstructions({ kind, packName: 'Пакет', packSummary: 'Раундов: 2, вопросов: 3.', roster: roster() })])
  }
  return list
}

describe('подсказки ведущей: без ремарок, тона-прилагательных и скобок', () => {
  for (const [name, text] of allCues()) {
    it(name, () => {
      const folded = text.toLocaleLowerCase('ru').replaceAll('ё', 'е')
      for (const word of STOP) expect(folded, `${name}: «${word}»`).not.toContain(word)
      const oblique = /(?:^|[\s«])(?:к|у|от|для|с|Спроси|Поторопи|попроси|Попроси|назови|Скажи|скажи|Поздравь|обратись к|Обратись к)\s+(?:Боря|Маша|Игрок 3)(?=[\s,.:;!?»]|$)/u
      expect(spokenPayload(text).match(oblique)?.[0] ?? null, `${name}: имя в косвенном падеже`).toBeNull()
      expect(spokenPayload(text).match(/.{0,40}[()].{0,40}/)?.[0] ?? null, `${name}: скобки`).toBeNull()
    })
  }
})

describe('служебные слова в речи ведущей', () => {
  it('пишет заметку в trace', () => {
    pushHostLine('Итак, продолжим: Боря, выбирайте.')
    const note = getTrace().filter((entry) => entry.kind === 'note').at(-1)
    expect(note?.title).toContain('служебные слова: продолжим, итак')
  })
  it('обычная реплика без заметки', () => {
    const before = getTrace().length
    pushHostLine('Боря, выбирайте вопрос.')
    expect(getTrace().slice(before).some((entry) => entry.kind === 'note')).toBe(false)
  })
})
