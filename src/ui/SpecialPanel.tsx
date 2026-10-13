import { optionLabel } from '../game/auction.ts'
import { questionById } from '../game/pack.ts'
import type { AuctionOption, GameContext, PlayerId } from '../game/types.ts'
import type { ReactNode } from 'react'

export type SpecialPick =
  | { target: 'player'; playerId: PlayerId }
  | { target: 'stake'; amount: number }
  | { target: 'auction'; option: AuctionOption }

function publicFile(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`
}

/** Табло на коте/аукционе: картинка, тема, ставки и кнопки. `canAct(id)` — может ли этот экран нажимать за игрока. */
export function SpecialPanel(props: {
  context: GameContext
  path: string
  canAct: (playerId: PlayerId) => boolean
  onPick: (pick: SpecialPick) => void
  timer?: ReactNode
}) {
  const { context, path, canAct, onPick, timer } = props
  const special = context.special
  if (!special) return null
  const question = questionById(context.questions, special.questionId)
  const name = (id: PlayerId | null) => context.players.find((player) => player.id === id)?.name ?? `Игрок ${id ?? ''}`

  if (path === 'specialAway') {
    return (
      <article className="question special-panel" aria-label={special.kind === 'cat' ? 'Кот в мешке' : 'Аукцион'}>
        <p className="eyebrow">{special.kind === 'cat' ? 'Кот в мешке' : 'Аукцион'}</p>
        <h2>Ждём игрока {name(special.awayPlayerId)}</h2>
        {timer}
      </article>
    )
  }

  if (special.kind === 'cat') {
    const theme = question?.cat?.theme || question?.themeName || ''
    const picking = special.recipientId === null
    const before = question?.cat?.knows === 'before'
    const stakeButtons = path.startsWith('cat.staking') && special.stakeOptions.length > 1 && special.recipientId !== null && canAct(special.recipientId)
    const giverActs = picking && canAct(special.giverId)
    return (
      <article className="question special-panel special-cat" aria-label="Кот в мешке">
        {picking ? (
          <>
            <img className="special-art" src={publicFile('images/cat.svg')} alt="Кот в мешке" />
            <h2>Кот в мешке</h2>
            {before ? <p className="eyebrow">{theme} · {special.stakeOptions.join(' или ')}</p> : null}
            <p className="special-status">{name(special.giverId)} отдаёт вопрос</p>
            {giverActs && !path.endsWith('announcing') ? (
              <div className="special-options" role="group" aria-label="Кому отдать">
                {context.players.filter((player) => player.id !== special.giverId).map((player) => (
                  <button key={player.id} type="button" onClick={() => onPick({ target: 'player', playerId: player.id })}>{player.name}</button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="eyebrow">Кот в мешке · {name(special.recipientId)}</p>
            <h2>{theme}</h2>
            <p className="special-status">
              {special.stake !== null
                ? `Ставка ${special.stake}`
                : special.stakeOptions.length > 1 ? `${name(special.recipientId)} делает ставку: ${special.stakeOptions.join(' или ')}` : `Цена ${special.stakeOptions[0] ?? special.nominal}`}
            </p>
            {stakeButtons ? (
              <div className="special-options" role="group" aria-label="Ставка">
                {special.stakeOptions.map((amount, index) => (
                  <button key={amount} type="button" onClick={() => onPick({ target: 'stake', amount })}>
                    {index === 0 ? `Минимум ${amount}` : `Максимум ${amount}`}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </article>
    )
  }

  const bidderActs = special.recipientId !== null && special.options.length > 0 && path !== 'auction.won' && canAct(special.recipientId)
  return (
    <article className="question special-panel special-auction" aria-label="Аукцион">
      <img className="special-art" src={publicFile('images/auction.svg')} alt="Аукцион" />
      <p className="eyebrow">{question?.themeName} · {special.nominal}</p>
      <h2>Аукцион</h2>
      <p className="special-bid">
        {special.leaderId !== null ? `${name(special.leaderId)} — ${special.allIn ? 'ва-банк ' : ''}${special.bid}` : `Минимум ${special.nominal}`}
      </p>
      {path === 'auction.won'
        ? <p className="special-status">Вопрос уходит игроку {name(special.leaderId)}</p>
        : special.recipientId !== null
          ? <p className="special-status">{name(special.recipientId)} {special.leaderId === null ? 'делает ставку' : 'решает, перекупать ли'}</p>
          : null}
      {bidderActs ? (
        <div className="special-options" role="group" aria-label="Ставка аукциона">
          {special.options.map((option) => (
            <button key={optionLabel(option)} type="button" onClick={() => onPick({ target: 'auction', option })}>{optionLabel(option)}</button>
          ))}
        </div>
      ) : null}
      {special.log.length ? (
        <ul className="special-log" aria-label="Ход торгов">
          {special.log.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      ) : null}
    </article>
  )
}

/** Узлы, где табло показывает панель кота/аукциона вместо вопроса. */
export function specialPanelPath(path: string, context: GameContext): boolean {
  if (!context.special) return false
  return path.startsWith('cat.') || path.startsWith('auction.') || path === 'specialAway'
}
