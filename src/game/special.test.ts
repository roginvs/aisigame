import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { catAwayWaitMs } from '../options.ts'
import { announceInstructions } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { Player, Question, QuestionPack } from './types.ts'

const base = { roundIndex: 0, text: 'Вопрос?', answers: ['ответ'] }
const pack: QuestionPack = {
  name: 'Спец',
  rounds: [{ index: 0, name: 'Р', kind: 'normal' }],
  questions: [
    { ...base, id: 'n100', themeId: 't', themeName: 'Обычная', value: 100 },
    { ...base, id: 'n500', themeId: 't', themeName: 'Обычная', value: 500 },
    { ...base, id: 'cat', themeId: 'c', themeName: 'Кот', value: 200, cat: { source: 'cat', theme: 'Звери', price: { kind: 'roundMinMax' }, knows: 'after', options: [100, 500] } },
    { ...base, id: 'catFixed', themeId: 'c', themeName: 'Кот', value: 300, cat: { source: 'cat', theme: '', price: { kind: 'fixed', value: 300 }, knows: 'after', options: [300] } },
    { ...base, id: 'auc', themeId: 'a', themeName: 'Торги', value: 100, auction: { source: 'auction' } },
  ] satisfies Question[],
  warnings: [],
}

function start(names: string[], scores: number[] = []) {
  const players: Player[] = names.map((name, index) => ({ id: index + 1, name, score: scores[index] ?? 0 }))
  const actor = createActor(gameMachine).start()
  actor.send({ type: 'START_GAME', pack, players })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  return actor
}
type Actor = ReturnType<typeof start>
const path = (actor: Actor) => statePath(actor.getSnapshot().value)
const ctx = (actor: Actor) => actor.getSnapshot().context
const score = (actor: Actor, id: number) => ctx(actor).players.find((p) => p.id === id)?.score
const heard = (actor: Actor, purpose: Parameters<typeof actor.send>[0] extends infer E ? E extends { type: 'HOST_AUDIO_FINISHED'; purpose: infer P } ? P : never : never) =>
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose })
function judge(actor: Actor, status: 'correct' | 'incorrect') {
  const c = ctx(actor)
  actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
  actor.send({ type: 'ANSWER_JUDGED', judgment: { questionId: c.activeQuestionId!, playerId: c.activePlayerId!, attemptId: c.attemptId, status, heard: 'x', reason: '' } })
}
function readAndAnswer(actor: Actor) {
  // После ставки кота/аукциона — сразу чтение, без второго мигания табло (`flashing`).
  expect(path(actor)).toBe('reading.sealed')
  // Кнопок нет: фальстарт не засчитывается.
  actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
  expect(ctx(actor).falseStarts[2]).toBeUndefined()
  vi.advanceTimersByTime(gameConfig.cellFlashMs)
  vi.advanceTimersByTime(20_000)
  expect(path(actor)).toBe('reading.sealed')
  heard(actor, 'read')
  expect(path(actor)).toBe('answering.waiting')
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function appeal(actor: Actor, playerId: number) {
  const a = ctx(actor).appeal!
  actor.send({ type: 'APPEAL_REQUESTED', questionId: a.questionId, windowId: a.windowId, playerId, requestId: `r${Math.random()}` })
}

describe('апелляции кота и аукциона', () => {
  it('кот: минус ставки → «Да, ответил верно» → плюс ставки, а не номинала', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    heard(actor, 'cat')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 3 })
    heard(actor, 'catStake')
    actor.send({ type: 'CAT_STAKE', playerId: 3, amount: 500 })
    readAndAnswer(actor)
    judge(actor, 'incorrect')
    expect(score(actor, 3)).toBe(-500)
    expect(ctx(actor).outcomes?.cat?.[3]).toMatchObject({ amount: -500, stake: 500 })
    // Апелляция доступна сразу, ещё пока ведущая объявляет; подать может только ответивший.
    appeal(actor, 1)
    expect(path(actor)).toBe('announcing.speaking')
    appeal(actor, 3)
    expect(path(actor)).toBe('appealConfirm')
    vi.advanceTimersByTime(1)
    expect(score(actor, 3)).toBe(500)
    expect(announceInstructions(ctx(actor))).toContain('было минус пятьсот, стало плюс пятьсот')
    heard(actor, 'announce')
    expect(path(actor)).toBe('choosing.listening')
  })

  it('аукцион: апелляция в окне выбора тоже на ставку', () => {
    const actor = start(['Аня', 'Боря', 'Вася'], [0, 700, 0])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    heard(actor, 'auction')
    actor.send({ type: 'AUCTION_BID', playerId: 2, option: { kind: 'stake', amount: 300 } })
    expect(path(actor)).toBe('auction.won')
    heard(actor, 'auctionWon')
    readAndAnswer(actor)
    judge(actor, 'incorrect')
    expect(score(actor, 2)).toBe(400)
    heard(actor, 'announce')
    expect(path(actor)).toBe('choosing.listening')
    appeal(actor, 2)
    expect(path(actor)).toBe('appealConfirm')
    vi.advanceTimersByTime(1)
    expect(score(actor, 2)).toBe(1000)
  })
})

describe('кот в мешке', () => {
  it('3 игрока: выбор голосом/кликом, себе нельзя, ставка мин/макс, ±ставка, выбирает получатель, без перехвата', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    expect(path(actor)).toBe('cat.announcing')
    expect(ctx(actor).special).toMatchObject({ kind: 'cat', giverId: 2, recipientId: null, stakeOptions: [100, 500] })
    heard(actor, 'cat')
    expect(path(actor)).toBe('cat.picking')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 2 })
    expect(path(actor)).toBe('cat.picking')
    actor.send({ type: 'CAT_PICK_UNCLEAR', reason: 'не имя' })
    expect(path(actor)).toBe('cat.clarifying')
    heard(actor, 'catClarify')
    expect(path(actor)).toBe('cat.picking')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 3 })
    expect(path(actor)).toBe('cat.staking.asking')
    // Ставка от чужого и не из вариантов отвергается.
    actor.send({ type: 'CAT_STAKE', playerId: 1, amount: 100 })
    actor.send({ type: 'CAT_STAKE', playerId: 3, amount: 300 })
    expect(path(actor)).toBe('cat.staking.asking')
    heard(actor, 'catStake')
    actor.send({ type: 'CAT_STAKE_UNCLEAR', reason: 'сумма не из вариантов' })
    expect(path(actor)).toBe('cat.staking.clarifying')
    heard(actor, 'catStakeClarify')
    actor.send({ type: 'CAT_STAKE', playerId: 3, amount: 500 })
    expect(ctx(actor)).toMatchObject({ activePlayerId: 3, activeStake: 500 })
    readAndAnswer(actor)
    judge(actor, 'incorrect')
    expect(score(actor, 3)).toBe(-500)
    expect(ctx(actor).playedIds).toContain('cat')
    // Ячейка закрыта сразу: апелляция только подтверждением (Да/Нет), на ставку.
    expect(ctx(actor).appeal).toMatchObject({ questionId: 'cat', stage: 'closed' })
    heard(actor, 'announce')
    expect(path(actor)).toBe('choosing.listening')
    expect(ctx(actor).chooserId).toBe(3)
  })

  it('2 игрока: получатель автоматически второй; фиксированная цена без ставки; верно — +цена', () => {
    const actor = start(['Аня', 'Боря'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 300 })
    expect(ctx(actor).special?.recipientId).toBe(1)
    heard(actor, 'cat')
    expect(path(actor)).toBe('cat.staking.asking')
    heard(actor, 'catStake')
    expect(ctx(actor)).toMatchObject({ activePlayerId: 1, activeStake: 300 })
    readAndAnswer(actor)
    judge(actor, 'correct')
    expect(score(actor, 1)).toBe(300)
    expect(score(actor, 2)).toBe(0)
  })

  it('1 игрок — кот достаётся ему самому', () => {
    const actor = start(['Аня'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    expect(ctx(actor).special?.recipientId).toBe(1)
  })

  it('получатель отключился: вернулся — ставка заново; не вернулся на ответе — 0 очков, выбирает следующий', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    heard(actor, 'cat')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 1 })
    actor.send({ type: 'SPECIAL_PLAYER_OFFLINE', playerId: 1, nextChooserId: 3 })
    expect(path(actor)).toBe('specialAway')
    actor.send({ type: 'SPECIAL_PLAYER_BACK', playerId: 1 })
    expect(path(actor)).toBe('cat.staking.asking')
    heard(actor, 'catStake')
    actor.send({ type: 'CAT_STAKE', playerId: 1, amount: 100 })
    readAndAnswer(actor)
    actor.send({ type: 'SPECIAL_PLAYER_OFFLINE', playerId: 1, nextChooserId: 3 })
    expect(path(actor)).toBe('specialAway')
    vi.advanceTimersByTime(catAwayWaitMs)
    expect(path(actor)).toBe('announcing.speaking')
    expect(ctx(actor).announceKind).toBe('away')
    expect(ctx(actor).playedIds).toContain('cat')
    expect(score(actor, 1)).toBe(0)
    heard(actor, 'announce')
    expect(ctx(actor).chooserId).toBe(3)
  })

  it('вернулся на ответе — окно ответа заново, вопрос не перечитывается', () => {
    const actor = start(['Аня', 'Боря'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 300 })
    heard(actor, 'cat'); heard(actor, 'catStake')
    readAndAnswer(actor)
    const attempt = ctx(actor).attemptId
    actor.send({ type: 'SPECIAL_PLAYER_OFFLINE', playerId: 1, nextChooserId: 2 })
    actor.send({ type: 'SPECIAL_PLAYER_BACK', playerId: 1 })
    expect(path(actor)).toBe('answering.waiting')
    expect(ctx(actor).attemptId).toBeGreaterThan(attempt)
  })

  it('пауза и RESUME в выборе и ставке', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    heard(actor, 'cat')
    actor.send({ type: 'PAUSE', path: path(actor) })
    actor.send({ type: 'RESUME' })
    expect(path(actor)).toBe('cat.announcing')
    heard(actor, 'cat')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 1 })
    heard(actor, 'catStake')
    actor.send({ type: 'PAUSE', path: path(actor) })
    actor.send({ type: 'RESUME' })
    expect(path(actor)).toBe('cat.staking.asking')
  })

  it('ушёл отдающий — право переходит следующему', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    heard(actor, 'cat')
    actor.send({ type: 'CHOOSER_OFFLINE', fromPlayerId: 2, toPlayerId: 3 })
    expect(path(actor)).toBe('cat.announcing')
    expect(ctx(actor).special?.giverId).toBe(3)
    heard(actor, 'cat')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 3 })
    expect(path(actor)).toBe('cat.picking')
  })
})

describe('аукцион', () => {
  // Открывает игрок 2 (openingChooser), круг 2 → 3 → 1.
  it('торги по кругу: перекупка, автопас бедного, ва-банк, победитель отвечает ±ставка и выбирает', () => {
    const actor = start(['Аня', 'Боря', 'Вася'], [1000, 500, 50])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    expect(path(actor)).toBe('auction.announcing')
    expect(ctx(actor).special?.options.map((o) => o.kind === 'pass' ? 'pass' : o.amount)).toEqual([100, 200, 300, 400, 500])
    heard(actor, 'auction')
    expect(path(actor)).toBe('auction.listening')
    actor.send({ type: 'AUCTION_BID', playerId: 1, option: { kind: 'stake', amount: 200 } })
    actor.send({ type: 'AUCTION_BID', playerId: 2, option: { kind: 'stake', amount: 250 } })
    expect(path(actor)).toBe('auction.listening')
    actor.send({ type: 'AUCTION_BID', playerId: 2, option: { kind: 'stake', amount: 200 } })
    // Вася (50) автопас, спрашиваем Аню.
    expect(path(actor)).toBe('auction.asking')
    expect(ctx(actor).special).toMatchObject({ recipientId: 1, leaderId: 2, bid: 200, passed: [3] })
    heard(actor, 'auctionAsk')
    actor.send({ type: 'AUCTION_BID', playerId: 1, option: { kind: 'allIn', amount: 1000 } })
    // Боря (500) не перебивает ва-банк 1000 — автопас, торги окончены.
    expect(path(actor)).toBe('auction.won')
    expect(ctx(actor).special).toMatchObject({ leaderId: 1, bid: 1000, allIn: true })
    heard(actor, 'auctionWon')
    expect(ctx(actor)).toMatchObject({ activePlayerId: 1, activeStake: 1000 })
    readAndAnswer(actor)
    judge(actor, 'incorrect')
    expect(score(actor, 1)).toBe(0)
    expect(ctx(actor).playedIds).toContain('auc')
    heard(actor, 'announce')
    expect(ctx(actor).chooserId).toBe(1)
  })

  it('денег не больше номинала — автоматически номинал; один игрок — сразу вопрос', () => {
    const actor = start(['Аня'], [0])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    expect(ctx(actor).special).toMatchObject({ bid: 100, leaderId: 1 })
    heard(actor, 'auction')
    expect(path(actor)).toBe('auction.won')
    heard(actor, 'auctionWon')
    readAndAnswer(actor)
    judge(actor, 'correct')
    expect(score(actor, 1)).toBe(100)
  })

  it('пас окончательный; перекупленный выбравший снова ходит; неясно — переспрос', () => {
    const actor = start(['Аня', 'Боря'], [1000, 1000])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    heard(actor, 'auction')
    actor.send({ type: 'AUCTION_BID', playerId: 2, option: { kind: 'stake', amount: 100 } })
    heard(actor, 'auctionAsk')
    actor.send({ type: 'AUCTION_UNCLEAR', reason: 'не вариант' })
    expect(path(actor)).toBe('auction.clarifying')
    heard(actor, 'auctionClarify')
    actor.send({ type: 'AUCTION_BID', playerId: 1, option: { kind: 'stake', amount: 200 } })
    expect(ctx(actor).special?.recipientId).toBe(2)
    heard(actor, 'auctionAsk')
    actor.send({ type: 'AUCTION_BID', playerId: 2, option: { kind: 'pass' } })
    expect(path(actor)).toBe('auction.won')
    expect(ctx(actor).special?.leaderId).toBe(1)
  })

  it('спрашиваемый отключился: 15 с — автопас', () => {
    const actor = start(['Аня', 'Боря', 'Вася'], [1000, 1000, 1000])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    heard(actor, 'auction')
    actor.send({ type: 'AUCTION_BID', playerId: 2, option: { kind: 'stake', amount: 100 } })
    actor.send({ type: 'SPECIAL_PLAYER_OFFLINE', playerId: 3, nextChooserId: 1 })
    expect(path(actor)).toBe('specialAway')
    vi.advanceTimersByTime(catAwayWaitMs)
    expect(path(actor)).toBe('auction.asking')
    expect(ctx(actor).special).toMatchObject({ recipientId: 1, passed: [3] })
  })

  it('выбравший ушёл до открытия — автоматически номинал; пауза в торгах восстанавливает вопрос ставки', () => {
    const actor = start(['Аня', 'Боря'], [1000, 1000])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    actor.send({ type: 'CHOOSER_OFFLINE', fromPlayerId: 2, toPlayerId: 1 })
    expect(path(actor)).toBe('auction.asking')
    expect(ctx(actor).special).toMatchObject({ bid: 100, leaderId: 2, recipientId: 1 })
    actor.send({ type: 'PAUSE', path: path(actor) })
    actor.send({ type: 'RESUME' })
    expect(path(actor)).toBe('auction.asking')
  })
})

describe('восстановление', () => {
  it('сохранённый кот после reload продолжается со ставки получателя', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    heard(actor, 'cat')
    actor.send({ type: 'CAT_RECIPIENT', playerId: 3 })
    const c = ctx(actor)
    const saved = {
      players: c.players, roundIndex: c.roundIndex, playedIds: c.playedIds, missedIds: c.missedIds, chooserId: c.chooserId,
      finalists: [], bets: [], finalCursor: 0, betMisses: 0, activeQuestionId: c.activeQuestionId, activePlayerId: null,
      activeStake: null, attemptId: c.attemptId, clarifications: 0, heard: '', wrongHeard: [], sayCloseGuess: false,
      announceKind: null, judgmentStatus: null, phase: path(actor), special: c.special,
    }
    const next = createActor(gameMachine).start()
    next.send({ type: 'CONTINUE_GAME', pack, saved })
    next.send({ type: 'CONNECTED' })
    expect(statePath(next.getSnapshot().value)).toBe('cat.staking.asking')
    expect(next.getSnapshot().context.special?.recipientId).toBe(3)
  })
})
