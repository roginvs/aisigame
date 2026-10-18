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
import { buzzKeyLabel, isKeyboardPlayer } from './buzzKeys.ts'
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
  onConfirmNo?: () => void
  onBuzz: (playerId: PlayerId) => void
  /** Чья кнопка сейчас мигает подсказкой «жми» (только свой игрок, только на этом экране). */
  nudgePlayerId?: PlayerId | null
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
    return (
      <section
        className="players conference-players"
        style={paused ? ({ '--pause-cols': String(pauseColumns(entries.length)) } as CSSProperties) : undefined}
        aria-label="Участники"
      >
        {entries.map((entry) => {
          const isSelf = Boolean(selfClientId && entry.clientId === selfClientId)
          const tile =
            matchConferenceTile(tiles, {
              selfClientId,
              clientId: entry.clientId,
              jitsiIds,
            }) ?? emptyTile(entry.clientId, entry.name, isSelf)
          return (
            <div
              key={entry.clientId}
              className={['player', 'conference-player', isSelf ? 'self' : '', entry.stale ? 'stale' : '']
                .filter(Boolean)
                .join(' ')}
              role="group"
              data-jitsi-id={jitsiIdOfClient(jitsiIds, entry.clientId) ?? undefined}
              aria-label={entry.name}
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
          )
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
        const key = layout ? '' : isKeyboardPlayer(playerId) ? buzzKeyLabel[playerId] : ''
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
              {props.confirmingId === playerId && props.onConfirmYes && props.onConfirmNo ? (
                <AppealConfirm onYes={props.onConfirmYes} onNo={props.onConfirmNo} />
              ) : (
              <button
                type="button"
                key={cooling ? 'penalty' : 'ready'}
                className={['buzzer', chooses ? 'chooser' : '', cooling ? 'false-start' : '', !cooling && props.nudgePlayerId === playerId ? 'buzz-nudge' : '']
                  .filter(Boolean)
                  .join(' ')}
                style={
                  cooling
                    ? {
                        animationDuration: `${falseStartMs}ms`,
                        animationPlayState: paused ? 'paused' : 'running',
                      }
                    : props.nudgePlayerId === playerId
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
              {key || isSelf ? (
                <p className="key-hint">{key ? (earlyLive ? `${key} · уже можно` : key) : 'Пробел'}</p>
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

