import type { LinkStatus } from '../realtime/client.ts'
import { hostCaption, hostCopy, hostMood, type HostMood } from './hostMood.ts'

const publicFile = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

const portrait: Record<HostMood, string> = {
  listen: publicFile('/host/listen.jpg'),
  speak: publicFile('/host/speak.jpg?v=3'),
  buzz: publicFile('/host/buzz.jpg'),
  think: publicFile('/host/think.jpg'),
}

export function HostPresence(props: {
  path: string
  link: Pick<LinkStatus, 'host' | 'mic'>
  status: string
  /** Персональный статус хода в конференции, например «Вася выбирает вопрос». */
  title?: string | null
  /** Строка под персональным ходом, например «Слушаю Вася» / «Ничего не слышу». */
  titleHint?: string | null
  /** Лобби конференции: вместо «Не говорите» приглашаем поболтать. */
  lobbyInvite?: boolean
  error?: string | null
  /** В онлайн-режиме: речь бота «Ведущая» по уровню Jitsi — золотая пульсация рамки. */
  conferenceSpeaking?: boolean
  /** Только мастер: вне хода модель глуха, на выборе/ответе — один игрок. */
  audioJudgment?: boolean
  audioJudgmentSupported?: boolean
  onAudioJudgmentChange?: (value: boolean) => void
  hearTurnOnly?: boolean
  onHearTurnOnlyChange?: (value: boolean) => void
}) {
  const paused = props.path === 'paused'
  const stopped = props.path === 'stopped'
  const mood = paused || stopped ? 'think' : hostMood(props.path, props.link)
  const listenHint = props.titleHint?.trim() || ''
  // Joiner шлёт phase «lobby»; у мастера машина ещё в startMenu — нужен lobbyInvite.
  const lobbyInvite = Boolean(props.lobbyInvite) || props.path === 'lobby'
  // titleHint из конференции важнее шаблонного hint настроения («Слышу вас…» на buzz),
  // иначе при «Меньше слышать» в окне кнопки врёт «засчитаю только после кнопки».
  const copy = props.title
    ? { title: props.title, hint: listenHint }
    : stopped
      ? { title: 'Остановлена', hint: listenHint || 'Сессия закрыта, ведущая не ждёт' }
      : paused
        ? { title: 'Пауза', hint: listenHint || 'Микрофон выключен, ведущая не ждёт' }
        : {
            title: lobbyInvite ? 'Можно поболтать' : hostCopy[mood].title,
            hint: listenHint || hostCopy[mood].hint,
          }
  const caption = hostCaption({ title: copy.title, hint: copy.hint, status: props.title ? '' : props.status })
  const classes = [
    'host',
    `host-${mood}`,
    stopped ? 'host-stopped' : '',
    props.conferenceSpeaking ? 'speaking' : '',
    props.onHearTurnOnlyChange || props.onAudioJudgmentChange ? 'host-with-hear-less' : '',
    props.onHearTurnOnlyChange && props.onAudioJudgmentChange ? 'host-with-two-switches' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <figure className={classes} role="status" aria-live="polite">
      <img src={portrait[mood]} alt="" />
      <figcaption>
        <strong>{caption.title}</strong>
        {caption.lines.map((line) => (
          <span key={line} className="host-line">
            {line}
          </span>
        ))}
        {props.error ? <span className="host-line host-error">{props.error}</span> : null}
      </figcaption>
      {props.onHearTurnOnlyChange || props.onAudioJudgmentChange ? (
        <div className="host-switches">
          {props.onAudioJudgmentChange ? (
            <label
              className={['host-hear-less', props.audioJudgment && props.audioJudgmentSupported !== false ? 'is-on' : '', props.audioJudgmentSupported === false ? 'is-disabled' : ''].filter(Boolean).join(' ')}
              title={props.audioJudgmentSupported === false ? 'Эта модель не поддерживает оценку по аудио; ответы проверяются по тексту' : 'Включено — оценка по голосу. Выключено — прежняя проверка по распознанному тексту. Изменение действует со следующей попытки ответа.'}
            >
              <span className="host-hear-less-label">Оценивать по аудио</span>
              <input
                type="checkbox" className="host-switch-input" role="switch"
                aria-checked={Boolean(props.audioJudgment && props.audioJudgmentSupported !== false)}
                checked={Boolean(props.audioJudgment && props.audioJudgmentSupported !== false)}
                disabled={props.audioJudgmentSupported === false}
                onChange={(event) => props.onAudioJudgmentChange?.(event.target.checked)}
              />
              <span className="host-hear-less-track" aria-hidden="true"><span className="host-hear-less-thumb" /></span>
            </label>
          ) : null}
          {props.onHearTurnOnlyChange ? (
            <label
              className={['host-hear-less', props.hearTurnOnly ? 'is-on' : ''].filter(Boolean).join(' ')}
              title="В партии вне выбора и ответа модель ничего не слышит; на ходе — только этого игрока"
            >
              <span className="host-hear-less-label">Меньше слышать</span>
              <input
                type="checkbox"
                className="host-switch-input"
                role="switch"
                aria-checked={Boolean(props.hearTurnOnly)}
                checked={Boolean(props.hearTurnOnly)}
                onChange={(event) => props.onHearTurnOnlyChange?.(event.target.checked)}
              />
              <span className="host-hear-less-track" aria-hidden="true">
                <span className="host-hear-less-thumb" />
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
    </figure>
  )
}
