import type { LinkStatus } from '../realtime/client.ts'
import { hostCaption, hostCopy, hostMood, type HostMood } from './hostMood.ts'

const portrait: Record<HostMood, string> = {
  listen: '/host/listen.jpg',
  speak: '/host/speak.jpg?v=3',
  buzz: '/host/buzz.jpg',
  think: '/host/think.jpg',
}

export function HostPresence(props: {
  path: string
  link: Pick<LinkStatus, 'host' | 'mic'>
  status: string
  error?: string | null
}) {
  const paused = props.path === 'paused'
  const stopped = props.path === 'stopped'
  const mood = paused || stopped ? 'think' : hostMood(props.path, props.link)
  const copy = stopped
    ? { title: 'Остановлена', hint: 'Сессия закрыта, ведущая не ждёт' }
    : paused
      ? { title: 'Пауза', hint: 'Микрофон выключен, ведущая не ждёт' }
      : hostCopy[mood]
  const caption = hostCaption({ title: copy.title, hint: copy.hint, status: props.status })
  return (
    <figure className={stopped ? `host host-${mood} host-stopped` : `host host-${mood}`} role="status" aria-live="polite">
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
    </figure>
  )
}
