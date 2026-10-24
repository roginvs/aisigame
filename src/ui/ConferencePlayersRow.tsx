import { pendingGuests } from './pendingGuests.ts'
import { AppealConfirm } from './AppealConfirm.tsx'
import { packProgressLabel } from '../conference/packProgress.ts'
import { tapPressProps } from './tapPress.ts'
import type { CSSProperties } from 'react'
import { buzzNudge } from '../options.ts'
import { buzzerLabel } from './buzzerLabel.ts'
import type { ConferenceTile } from '../conference/media.ts'
import type { RosterEntry } from '../conference/roster.ts'
import type { Player, PlayerId } from '../game/types.ts'
import { falseStartCooling } from '../game/machine.ts'
import { falseStartMs } from '../options.ts'
import { buzzKeyLabel, isKeyboardPlayer, localSeatKeyLabel } from './buzzKeys.ts'
import { rosterSeats } from '../conference/seats.ts'
import { canBuzzPlayer } from './conferenceTurn.ts'
import { conferencePlayerLabel } from './conferencePlayerLabel.ts'
import { matchConferenceTile } from './conferenceTileMatch.ts'
import { jitsiIdOfClient } from '../conference/jitsiIds.ts'
import type { ConferenceJitsiPair } from '../conference/messages.ts'
import { ConferenceVideoTile } from './ConferenceVideoStrip.tsx'
import { pauseColumns } from './pauseColumns.ts'

type BindVideo = (participantId: string, element: HTMLVideoElement | null) => void

/** Пустая карточка, пока нет пары `[jitsiId, clientId]`; id по устройству/игроку, не по имени (одинаковые имена). */
const emptyTile = (key: string, name: string, isLocal: boolean): ConferenceTile => ({
  id: isLocal ? 'local-pending' : `pending:${key}`,
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
  /** Пары `[jitsiId, clientId]` из полученного снимка — по ним карточка находит камеру. */
  jitsiIds?: readonly ConferenceJitsiPair[]
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
  appealStates?: Record<number, { label: string; enabled: boolean } | null>
  /** Чья широкая кнопка апелляции сейчас заменена на «Да / Нет». */
  confirmingId?: number | null
  onConfirmYes?: () => void
  onBuzz: (playerId: PlayerId) => void
  /** Чьи кнопки сейчас мигают подсказкой «жми» (свои места, только на этом экране). */
  nudgePlayerIds?: readonly PlayerId[]
  layout: boolean
}) {
  const {
    mode,
    tiles,
    bindVideo,
    selfClientId,
    jitsiIds,
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
    const lobbyCards = entries.reduce((sum, entry) => sum + rosterSeats(entry).length, 0)
    return (
      <section
        className="players conference-players"
        style={paused ? ({ '--pause-cols': String(pauseColumns(lobbyCards)) } as CSSProperties) : undefined}
        aria-label="Участники"
      >
        {entries.flatMap((entry) => {
          const isSelf = Boolean(selfClientId && entry.clientId === selfClientId)
          const tile =
            matchConferenceTile(tiles, {
              selfClientId,
              clientId: entry.clientId,
              jitsiIds,
            }) ?? emptyTile(entry.clientId, entry.name, isSelf)
          return rosterSeats(entry).map((seat, index) => (
            <div
              key={`${entry.clientId}:${seat.playerId ?? index}`}
              className={['player', 'conference-player', isSelf ? 'self' : '', entry.stale ? 'stale' : '']
                .filter(Boolean)
                .join(' ')}
              role="group"
              data-jitsi-id={jitsiIdOfClient(jitsiIds, entry.clientId) ?? undefined}
              aria-label={seat.name}
            >
              <ConferenceVideoTile tile={tile} bindVideo={bindVideo} masterBadge={entry.isMaster} pingMs={entry.pingMs} />
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
          ))
        })}
      </section>
    )
  }

  const pending = pendingGuests(roster, players)
  return (
    <section
      className="players conference-players"
      style={paused ? ({ '--pause-cols': String(pauseColumns(players.length + pending.length)) } as CSSProperties) : undefined}
      aria-label="Участники"
    >
      {players.map((player) => {
        const playerId = player.id
        const label = conferencePlayerLabel(player.name, hasMatchData)
        const active = activePlayerId === playerId
        const missed = missedIds.includes(playerId)
        const appealState = props.appealStates?.[playerId]
        const chooses = path.startsWith('choosing') && chooserId === playerId
        const flareAt = falseStarts[playerId]
        const cooling = falseStartCooling(flareAt, penaltyClock)
        const canControl = canBuzzPlayer(layout, selfClientId, player)
        const isSelf = layout && canControl
        const displayOnly = layout && !canControl
        const localIds = layout
          ? players.filter((item) => item.clientId && selfClientId && item.clientId === selfClientId).map((item) => item.id)
          : []
        const key = layout
          ? (canControl ? (localSeatKeyLabel(localIds.indexOf(playerId), localIds.length) ?? '') : '')
          : (isKeyboardPlayer(playerId) ? buzzKeyLabel[playerId] : '')
        const presence = player.clientId
          ? roster.find((entry) => entry.clientId === player.clientId)
          : undefined
        const stale = Boolean(presence?.stale)
        const tile =
          matchConferenceTile(tiles, {
            selfClientId,
            clientId: player.clientId,
            jitsiIds,
          }) ?? emptyTile(String(playerId), label, Boolean(isSelf))

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
            data-jitsi-id={jitsiIdOfClient(jitsiIds, player.clientId) ?? undefined}
            aria-label={`${label}: ${hasMatchData ? player.score : '—'}${stale ? ', нет связи' : ''}`}
          >
            <ConferenceVideoTile tile={tile} bindVideo={bindVideo} hideName pingMs={presence?.pingMs} />
            <div className="player-game-slot">
              <div className="player-meta">
                <strong>{label}</strong>
                <span>{hasMatchData ? player.score : '—'}</span>
              </div>
              {props.confirmingId === playerId && props.onConfirmYes ? (
                <AppealConfirm onYes={props.onConfirmYes} />
              ) : (
              <button
                type="button"
                key={cooling ? 'penalty' : 'ready'}
                className={['buzzer', chooses ? 'chooser' : '', cooling ? 'false-start' : '', !cooling && props.nudgePlayerIds?.includes(playerId) ? 'buzz-nudge' : '']
                  .filter(Boolean)
                  .join(' ')}
                style={
                  cooling
                    ? {
                        animationDuration: `${falseStartMs}ms`,
                        animationPlayState: paused ? 'paused' : 'running',
                      }
                    : props.nudgePlayerIds?.includes(playerId)
                      ? ({ '--nudge-ms': `${buzzNudge.flashMs}ms`, '--nudge-count': String(buzzNudge.flashes) } as CSSProperties)
                      : undefined
                }
                disabled={displayOnly || (appealState ? !appealState.enabled : cooling || ((missed || !buttonsOpen) && !canFalseStart))}
                {...tapPressProps(() => onBuzz(playerId))}
              >
                {buzzerLabel({
                  appealLabel: appealState?.label,
                  cooling,
                  normal: chooses ? 'выбирайте вопрос' : missed ? 'Уже отвечал' : buttonsOpen || canFalseStart ? 'Жмите' : '\u00a0',
                })}
                {earlyLive ? <span className="visually-hidden">, вопрос ещё читается</span> : null}
              </button>
              )}
              {key ? (
                <p className="key-hint">{earlyLive ? `${key} · уже можно` : key}</p>
              ) : null}
            </div>
          </div>
        )
      })}
      {pending.map((entry) => {
        const isSelf = Boolean(selfClientId && entry.clientId === selfClientId)
        const tile =
          matchConferenceTile(tiles, { selfClientId, clientId: entry.clientId, jitsiIds }) ?? emptyTile(entry.clientId, entry.name, isSelf)
        return (
          <div
            key={`pending-${entry.clientId}`}
            className={['player', 'conference-player', 'pending-guest', isSelf ? 'self' : '', entry.stale ? 'stale' : ''].filter(Boolean).join(' ')}
            role="group"
            data-jitsi-id={jitsiIdOfClient(jitsiIds, entry.clientId) ?? undefined}
            aria-label={`${entry.name}, ещё не играет`}
            data-pending="true"
          >
            <ConferenceVideoTile tile={tile} bindVideo={bindVideo} pingMs={entry.pingMs} />
            <div className="player-lobby-progress">
              <div className="roster-bar" role="progressbar" aria-valuenow={entry.percent} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, entry.percent / 100))})` }} />
              </div>
              <p className="status-line">{packProgressLabel(entry)} · ещё не играет</p>
            </div>
          </div>
        )
      })}
    </section>
  )
}

