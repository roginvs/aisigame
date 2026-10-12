import { packProgressLabel } from '../conference/packProgress.ts'
import type { RosterEntry } from '../conference/roster.ts'

export function ConferenceRosterPanel(props: {
  roster: RosterEntry[]
  masterOffline: boolean
  isMaster: boolean
  onStart?: () => void
  onReady?: () => void
  readyDisabled: boolean
  waitingMaster?: boolean
}) {
  const { roster, masterOffline, isMaster, onStart, onReady, readyDisabled, waitingMaster } = props
  return (
    <div className="conference-roster" aria-label="Игроки в лобби">
      {waitingMaster ? <p className="status-line">Ждём мастер-игрока</p> : null}
      {masterOffline ? <p className="error banner">Мастер-игрок отключился</p> : null}
      <ul className="roster-list">
        {roster.map((entry) => (
          <li key={entry.clientId} className={['roster-card', entry.stale ? 'stale' : ''].filter(Boolean).join(' ')}>
            <div className="roster-head">
              <strong>{entry.name}</strong>
              {entry.isMaster ? <span className="roster-tag">мастер</span> : null}
            </div>
            {!entry.isMaster ? (
              <>
                <div className="roster-bar" role="progressbar" aria-valuenow={entry.percent} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, entry.percent / 100))})` }} />
                </div>
                <p className="status-line">{packProgressLabel(entry)}</p>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {isMaster ? (
        <button type="button" className="primary" onClick={onStart}>
          Начать игру
        </button>
      ) : (
        <button type="button" className="primary" disabled={readyDisabled} onClick={onReady}>
          Я готов
        </button>
      )}
    </div>
  )
}
