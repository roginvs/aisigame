import { useState } from 'react'
import { readConferenceName, writeConferenceName } from '../conference/prefs.ts'

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
          <input
            value={name}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={!name.trim() || busy}
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
