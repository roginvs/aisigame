import type { AppealContext, AppealRequest, GameContext, OutcomeLedger, PlayerId } from './types.ts'

export const APPEAL_WINDOW_MS = 7_000
let appealScale = 1
/** Демо и e2e: растянуть окно апелляции (4 — в четыре раза дольше), чтобы тест под нагрузкой не опаздывал к кнопке. */
export function setAppealScale(next: number): void {
  appealScale = Number.isFinite(next) && next > 0 ? next : 1
}
export function appealWindowMs(): number {
  return Math.round(APPEAL_WINDOW_MS * appealScale)
}

export function eligibleAppealPlayers(context: Pick<GameContext, 'outcomes' | 'players'>, questionId: string): PlayerId[] {
  return context.players.filter((player) => {
    const outcome = context.outcomes?.[questionId]?.[player.id]
    return outcome !== undefined && outcome.amount <= 0 && outcome.correct !== true
  }).map((player) => player.id)
}

export function appealMsLeft(appeal: AppealContext | null | undefined): number {
  if (!appeal) return 0
  return Math.max(0, appeal.remainingMs - (appeal.startedAt === null ? 0 : Date.now() - appeal.startedAt))
}

export function appealRequestError(context: GameContext, path: string, request: AppealRequest): string | null {
  const appeal = context.appeal
  if (path === 'paused' || path === 'stopped') return 'Игра приостановлена'
  if (!appeal || appeal.timeUp || appeal.questionId !== request.questionId || appeal.windowId !== request.windowId) return 'Окно апелляции закрыто'
  const series = appeal.activePlayerId !== null && appeal.stage === 'closed'
  // `stateIn('announcing')` в машине покрывает и субсостояние holding —
  // кнопка апелляции не мигает во время удержания медиа ответа.
  const announcing = path === 'announcing' || path.startsWith('announcing.')
  const window = appeal.stage === 'open' ? path === 'buzzing.open' || announcing : path.startsWith('choosing.') || path === 'roundSummaryWindow' || announcing
  if (!series && !window) return 'Окно апелляции закрыто'
  if (!eligibleAppealPlayers(context, appeal.questionId).includes(request.playerId)) return 'Нет права на апелляцию'
  if (appeal.acceptedRequestIds?.includes(request.requestId)) return 'Заявка уже принята'
  if (appeal.activePlayerId === request.playerId || appeal.queue.includes(request.playerId)) return 'Заявка уже принята'
  if (appeal.stage === 'open' && appeal.lastPlayerId !== request.playerId) return 'Сейчас отвечает другой игрок'
  return null
}

export function appealButton(context: GameContext, path: string, playerId: PlayerId): { label: string; enabled: boolean } | null {
  const appeal = context.appeal
  if (!appeal || path === 'paused' || path === 'stopped' || path === 'finished') return null
  if (appeal.activePlayerId === playerId) return { label: 'Отвечаете', enabled: false }
  if (appeal.queue.includes(playerId)) return { label: 'В очереди', enabled: false }
  const error = appealRequestError(context, path, { questionId: appeal.questionId, windowId: appeal.windowId, playerId, requestId: 'ui' })
  return error ? null : { label: 'Апелляция', enabled: true }
}

/** Новая попытка заменяет итог пары; старый/дублированный результат ничего не применяет. */
/** Сумма апелляции: ставка кота/аукциона, если была, иначе номинал ячейки. */
export function appealStake(context: Pick<GameContext, 'outcomes' | 'questions'>, questionId: string, playerId: PlayerId | null): number {
  const stake = playerId ? context.outcomes?.[questionId]?.[playerId]?.stake : undefined
  return stake ?? context.questions.find((question) => question.id === questionId)?.value ?? 0
}

export function settleOutcome(context: GameContext, amount: number, correct = amount > 0): Pick<GameContext, 'players' | 'outcomes'> {
  const questionId = context.activeQuestionId
  const playerId = context.activePlayerId
  if (!questionId || !playerId) return { players: context.players, outcomes: context.outcomes }
  const previous = context.outcomes?.[questionId]?.[playerId]
  if (previous && previous.attemptId >= context.attemptId) return { players: context.players, outcomes: context.outcomes }
  const correction = amount - (previous?.amount ?? 0)
  const stake = context.activeStake ?? previous?.stake
  return {
    players: context.players.map((player) => player.id === playerId ? { ...player, score: player.score + correction } : player),
    outcomes: { ...context.outcomes, [questionId]: { ...context.outcomes?.[questionId], [playerId]: { amount, attemptId: context.attemptId, correct, previous: previous?.amount ?? 0, ...(stake != null ? { stake } : {}) } } },
  }
}

export function readOutcomes(value: unknown): OutcomeLedger | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  for (const players of Object.values(value)) {
    if (!players || typeof players !== 'object' || Array.isArray(players)) return null
    for (const [id, outcome] of Object.entries(players as Record<string, unknown>)) {
      if (!/^[1-9]\d*$/.test(id) || !outcome || typeof outcome !== 'object') return null
      const row = outcome as Record<string, unknown>
      if (!Number.isFinite(row.amount) || !Number.isSafeInteger(row.attemptId) || Number(row.attemptId) < 0 || (row.correct !== undefined && typeof row.correct !== 'boolean') || (row.previous !== undefined && !Number.isFinite(row.previous)) || (row.stake !== undefined && !Number.isFinite(row.stake))) return null
    }
  }
  return value as OutcomeLedger
}

export function readAppeal(value: unknown): AppealContext | null | undefined {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const a = value as AppealContext
  const player = (id: unknown) => Number.isSafeInteger(id) && Number(id) > 0
  if (typeof a.questionId !== 'string' || !a.questionId || !Number.isSafeInteger(a.windowId) || a.windowId < 1 ||
    !['open', 'closed'].includes(a.stage) || !Array.isArray(a.queue) || !a.queue.every(player) || new Set(a.queue).size !== a.queue.length ||
    (a.activePlayerId !== null && !player(a.activePlayerId)) || (a.lastPlayerId !== null && !player(a.lastPlayerId)) || !player(a.chooserId) ||
    !Number.isFinite(a.remainingMs) || a.remainingMs < 0 || a.remainingMs > appealWindowMs() ||
    (a.startedAt !== null && !Number.isFinite(a.startedAt))) return undefined
  if ((a.summary !== undefined && a.summary !== 'pending' && a.summary !== 'done') || (a.timeUp !== undefined && typeof a.timeUp !== 'boolean')) return undefined
  if (a.acceptedRequestIds !== undefined && (!Array.isArray(a.acceptedRequestIds) || a.acceptedRequestIds.some((id) => typeof id !== 'string' || id.length > 200))) return undefined
  return a
}
