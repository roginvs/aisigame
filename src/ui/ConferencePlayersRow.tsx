import { packProgressLabel } from '../conference/packProgress.ts'
import type { ConferenceTile } from '../conference/media.ts'
import type { RosterEntry } from '../conference/roster.ts'
import type { Player, PlayerId } from '../game/types.ts'
import { falseStartCooling } from '../game/machine.ts'
import { falseStartMs } from '../options.ts'
import { buzzKeyLabel, isKeyboardPlayer } from './buzzKeys.ts'
import { canBuzzPlayer } from './conferenceTurn.ts'
import { conferencePlayerLabel } from './conferencePlayerLabel.ts'
import { matchConferenceTile } from './conferenceTileMatch.ts'
import { ConferenceVideoTile } from './ConferenceVideoStrip.tsx'

type BindVideo = (participantId: string, element: HTMLVideoElement | null) => void

const emptyTile = (name: string, isLocal: boolean): ConferenceTile => ({
  id: isLocal ? 'local-pending' : `pending:${name}`,
  name,
  isLocal,
  micLive: false,
  cameraOn: false,
  speaking: false,
})

export function ConferencePlayersRow(props: {
  mode: 'lobby' | 'match'
  tiles: ConferenceTile[]
  bindVideo: BindVideo
  selfClientId?: string
  roster: RosterEntry[]
  players: Player[]
  hasMatchData: boolean
  path: string
  activePlayerId: PlayerId | null
  chooserId: PlayerId
  missedIds: PlayerId[]
  falseStarts: Partial<Record<PlayerId, number>>
  penaltyClock: number
  paused: boolean
  buttonsOpen: boolean
  canFalseStart: boolean
  earlyLive: boolean
  onBuzz: (playerId: PlayerId) => void
  layout: boolean
}) {
  const {
    mode,
    tiles,
    bindVideo,
    selfClientId,
    roster,
    players,
    hasMatchData,
    path,
    activePlayerId,
    chooserId,
    missedIds,
    falseStarts,
    penaltyClock,
    paused,
    buttonsOpen,
    canFalseStart,
    earlyLive,
    onBuzz,
    layout,
  } = props

  if (mode === 'lobby') {
    const entries = roster.filter((entry) => !entry.hidden || entry.isMaster)
    return (
      <section className="players conference-players" aria-label="Участники">
        {entries.map((entry) => {
          const isSelf = Boolean(selfClientId && entry.clientId === selfClientId)
          const tile =
            matchConferenceTile(tiles, {
              selfClientId,
              clientId: entry.clientId,
              name: entry.name,
            }) ?? emptyTile(entry.name, isSelf)
          return (
            <div
              key={entry.clientId}
              className={['player', 'conference-player', isSelf ? 'self' : '', entry.stale ? 'stale' : '']
                .filter(Boolean)
                .join(' ')}
              role="group"
              aria-label={entry.name}
            >
              <ConferenceVideoTile tile={tile} bindVideo={bindVideo} masterBadge={entry.isMaster} />
              {entry.isMaster ? (
                <div className="player-lobby-progress player-lobby-spacer" aria-hidden="true" />
              ) : (
                <div
                  className={['player-lobby-progress', entry.ready && entry.hashOk ? 'is-ready' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div
                    className="roster-bar"
                    role="progressbar"
                    aria-valuenow={entry.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, entry.percent / 100))})` }} />
                  </div>
                  <p className="status-line">{packProgressLabel(entry)}</p>
                </div>
              )}
            </div>
          )
        })}
      </section>
    )
  }

  return (
    <section className="players conference-players" aria-label="Участники">
      {players.map((player) => {
        const playerId = player.id
        const label = conferencePlayerLabel(player.name, hasMatchData)
        const active = activePlayerId === playerId
        const missed = missedIds.includes(playerId)
        const chooses = path.startsWith('choosing') && chooserId === playerId
        const flareAt = falseStarts[playerId]
        const cooling = falseStartCooling(flareAt, penaltyClock)
        const canControl = canBuzzPlayer(layout, selfClientId, player)
        const isSelf = layout && canControl
        const displayOnly = layout && !canControl
        const key = layout ? '' : isKeyboardPlayer(playerId) ? buzzKeyLabel[playerId] : ''
        const presence = player.clientId
          ? roster.find((entry) => entry.clientId === player.clientId)
          : undefined
        const stale = Boolean(presence?.stale)
        const tile =
          matchConferenceTile(tiles, {
            selfClientId,
            clientId: player.clientId,
            name: player.name,
          }) ?? emptyTile(label, Boolean(isSelf))

        return (
          <div
            key={playerId}
            className={[
              'player',
              'conference-player',
              active ? 'active' : '',
              isSelf ? 'self' : '',
              displayOnly ? 'display-only' : '',
              stale ? 'stale' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="group"
            aria-label={`${label}: ${hasMatchData ? player.score : '—'}${stale ? ', нет связи' : ''}`}
          >
            <ConferenceVideoTile tile={tile} bindVideo={bindVideo} hideName />
            <div className="player-game-slot">
              <div className="player-meta">
                <strong>{label}</strong>
                <span>{hasMatchData ? player.score : '—'}</span>
              </div>
              <button
                type="button"
                key={cooling ? 'penalty' : 'ready'}
                className={['buzzer', chooses ? 'chooser' : '', cooling ? 'false-start' : '']
                  .filter(Boolean)
                  .join(' ')}
                style={
                  cooling
                    ? {
                        animationDuration: `${falseStartMs}ms`,
                        animationPlayState: paused ? 'paused' : 'running',
                      }
                    : undefined
                }
                disabled={displayOnly || cooling || ((missed || !buttonsOpen) && !canFalseStart)}
                onClick={() => onBuzz(playerId)}
              >
                {chooses
                  ? 'выбирайте вопрос'
                  : missed
                    ? 'Уже отвечал'
                    : buttonsOpen || canFalseStart
                      ? 'Жмите'
                      : '\u00a0'}
                {earlyLive ? <span className="visually-hidden">, вопрос ещё читается</span> : null}
              </button>
              {key || isSelf ? (
                <p className="key-hint">{key ? (earlyLive ? `${key} · уже можно` : key) : 'Пробел'}</p>
              ) : null}
            </div>
          </div>
        )
      })}
    </section>
  )
}
