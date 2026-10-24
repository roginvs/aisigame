import { useState } from 'react'
import { readConferenceName, writeConferenceName } from '../conference/prefs.ts'
import { seatNamesFromText } from '../conference/seats.ts'

export function JoinConfirmScreen(props: {
  jitsiHost: string
  onJoin: (name: string) => void
  onDecline: () => void
  busy?: boolean
  status?: string | null
  error?: string | null
}) {
  const [name, setName] = useState(() => readConferenceName())
  const busy = Boolean(props.busy)
  return (
    <main className="start">
      <section className="card join-confirm">
        <p className="eyebrow">Приглашение в конференцию</p>
        <h1>Подключиться?</h1>
        <p className="lead">
          Ссылка ведёт на сервер <strong>{props.jitsiHost}</strong>. До нажатия «Подключиться» игра не открывает
          микрофон, не качает пакет и не подключается к комнате.
        </p>
        <label className="field">
          <span>Ваше имя</span>
          <textarea
            rows={2}
            value={name}
            placeholder="Аня; Боря"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="status-line">Имя с новой строки или через точку с запятой — вы и остальные за этим устройством.</p>
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={seatNamesFromText(name).length === 0 || busy}
            onClick={() => {
              writeConferenceName(name)
              props.onJoin(name.trim())
            }}
          >
            Подключиться
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={props.onDecline}>
            Не входить
          </button>
        </div>
        {busy && props.status ? <p className="status-line">{props.status}</p> : null}
        {props.error ? <p className="error">{props.error}</p> : null}
      </section>
    </main>
  )
}
