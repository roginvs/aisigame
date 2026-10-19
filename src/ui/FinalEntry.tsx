import { questionById, roundThemes } from '../game/pack.ts'
import type { GameContext, PlayerId } from '../game/types.ts'
import type { ReactNode } from 'react'

function playerName(context: GameContext, id: PlayerId | null | undefined): string {
  return context.players.find((player) => player.id === id)?.name ?? `Игрок ${id ?? ''}`
}

function themeName(context: GameContext): string {
  const struck = context.struckThemes ?? []
  const open = roundThemes(context.questions, context.roundIndex).filter((theme) => !struck.includes(theme.id))
  return questionById(context.questions, context.activeQuestionId)?.themeName ?? open[0]?.name ?? ''
}

function fieldType(kind: 'stake' | 'answer'): string {
  return kind === 'stake' ? 'Ставка' : 'Ответ'
}

function doneText(kind: 'stake' | 'answer'): string {
  return kind === 'stake' ? 'Ставка принята' : 'Ответ принят'
}

/** Финал: поля скрытого ввода для каждого финалиста (в конференции — только свои). */
export function FinalEntry(props: {
  context: GameContext
  kind: 'stake' | 'answer'
  canAct: (playerId: PlayerId) => boolean
  onSubmit: (playerId: PlayerId, value: number | string) => void
  timer?: ReactNode
}) {
  const { context, kind, canAct, onSubmit, timer } = props
  const entered = (id: PlayerId) =>
    kind === 'stake' ? context.bets.some((bet) => bet.playerId === id) : (context.typedIds ?? []).includes(id)
  const scoreOf = (id: PlayerId) => context.players.find((player) => player.id === id)?.score ?? 0
  return (
    <article className={kind === 'stake' ? 'question final-entry' : 'question special-panel final-entry'} aria-label={kind === 'stake' ? 'Ставки финала' : 'Ответы финала'}>
      {kind === 'stake' ? (
        <>
          <p className="eyebrow">Финал · {themeName(context)}</p>
          <h2>Скрытые ставки</h2>
          <p className="special-status">Ставка — очки на этот вопрос. Никто не видит чужую ставку до разбора.</p>
        </>
      ) : null}
      <div className="special-options final-entry-list">
        {context.finalists.map((id) => {
          if (entered(id)) {
            return (
              <p key={id} className="final-entry-done">{playerName(context, id)} — {doneText(kind)}</p>
            )
          }
          if (!canAct(id)) {
            return (
              <p key={id} className="final-entry-wait">{playerName(context, id)} — {kind === 'stake' ? 'решает ставку' : 'решает ответ'}</p>
            )
          }
          return (
            <form
              key={id}
              className={kind === 'stake' ? 'final-entry-field' : 'final-entry-field is-text'}
              onSubmit={(event) => {
                event.preventDefault()
                const form = event.currentTarget
                const input = form.querySelector('input')
                if (!input) return
                if (kind === 'stake') {
                  const amount = Number.parseInt(input.value, 10)
                  if (Number.isNaN(amount) || amount < 0) return
                  onSubmit(id, Math.min(amount, scoreOf(id)))
                } else {
                  const text = input.value.trim()
                  if (!text) return
                  onSubmit(id, text)
                }
                input.value = ''
              }}
            >
              <label>
                {playerName(context, id)}
                {kind === 'stake' ? <span className="final-entry-hint">{` очков из ${scoreOf(id)}`}</span> : null}
              </label>
              <input
                name="value"
                autoFocus
                inputMode={kind === 'stake' ? 'numeric' : 'text'}
                autoComplete="off"
                maxLength={kind === 'stake' ? 7 : 200}
                placeholder={kind === 'stake' ? '0' : 'Ответ'}
                aria-label={fieldType(kind)}
              />
              <button type="submit" className="primary">{fieldType(kind)}</button>
            </form>
          )
        })}
      </div>
      {timer}
    </article>
  )
}

/** Финал: разбор — кто уже раскрыл ответ, вердикт и ставка; идёт от меньшего счёта вверх. */
export function FinalRevealStrip(props: { context: GameContext }) {
  const { context } = props
  const current = context.finalists[context.finalCursor]
  const verdictMark = (id: PlayerId): string | null => {
    if (id !== context.activePlayerId || !context.judgmentStatus) return null
    if (context.judgmentStatus === 'correct') return '✓'
    if (context.judgmentStatus === 'incorrect') return '✗'
    return '≈'
  }
  return (
    <ul className="final-reveal" aria-label="Разбор ответов финала">
      {context.finalists.map((id) => {
        const revealed = (context.revealedIds ?? []).includes(id)
        const stake = (context.stakeShownIds ?? []).includes(id)
        const mark = verdictMark(id)
        const answer = revealed ? context.typedAnswers?.[id] : undefined
        return (
          <li
            key={id}
            className={id === current ? 'is-current' : undefined}
          >
            <span className="final-reveal-name">{playerName(context, id)}</span>
            <span className="final-reveal-answer">
              {answer !== undefined ? answer : id === current ? 'смотрим ответ…' : 'ответ скрыт'}
            </span>
            {mark ? <span className={context.judgmentStatus === 'correct' ? 'final-reveal-mark correct' : context.judgmentStatus === 'incorrect' ? 'final-reveal-mark incorrect' : 'final-reveal-mark near'}>{mark}</span> : null}
            {stake
              ? <span className="final-reveal-stake">ставка {id === context.activePlayerId ? (context.activeStake ?? 0) : (context.stakes?.[id] ?? 0)}</span>
              : null}
          </li>
        )
      })}
    </ul>
  )
}
