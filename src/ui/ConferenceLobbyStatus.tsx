/** Глобальный статус лобби на месте табло (прогресс — в ряде игроков). */
export function ConferenceLobbyStatus(props: {
  waitingMaster?: boolean
  masterOffline?: boolean
}) {
  const { waitingMaster, masterOffline } = props
  const line = waitingMaster
    ? 'Ждём мастер-игрока'
    : masterOffline
      ? 'Мастер-игрок отключился'
      : 'Ждём начала игры'
  return (
    <div className="conference-lobby-status" aria-live="polite">
      {masterOffline && !waitingMaster ? <p className="error banner">Мастер-игрок отключился</p> : null}
      <p className="status-line lobby-status-line">{line}</p>
    </div>
  )
}
