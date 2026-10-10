import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { getTrace, subscribeTrace, type ChatRole, type TraceEntry } from '../debug/trace.ts'
import { chatPinKey, isAtTail, pinColumn } from './chatScroll.ts'

export function ConversationChat() {
  const entries = useSyncExternalStore(subscribeTrace, getTrace, getTrace)
  const bubbles = entries.filter((entry) => entry.kind === 'chat')
  const pinned = usePinColumn(chatPinKey(bubbles))
  return (
    <aside className="chat-column" aria-label="Разговор">
      <div className="chat-head">
        <div>
          <p className="eyebrow">Разговор</p>
          <p className="chat-hint">Реплики ведущей, игроков и оценка.</p>
        </div>
      </div>
      <div className="chat-scroll" ref={pinned.scroller}>
        <div className="chat-log" ref={pinned.log}>
          {bubbles.length === 0 ? <p className="chat-hint">Пока тишина.</p> : null}
          {bubbles.map((entry) => (
            <Bubble key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </aside>
  )
}

function usePinColumn(signature: string) {
  const scroller = useRef<HTMLDivElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const own = useRef(false)

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const pin = () => {
      own.current = true
      pinColumn(node)
      follow.current = true
      own.current = false
    }
    // Новая строка всегда уходит вниз, даже если колонку уже прокрутили вверх.
    pin()
    let nested = 0
    const frame = requestAnimationFrame(() => {
      pin()
      nested = requestAnimationFrame(pin)
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(nested)
    }
  }, [signature])

  useEffect(() => {
    const node = scroller.current
    const content = log.current
    if (!node) return
    const onScroll = () => {
      if (own.current) return
      follow.current = isAtTail(node)
    }
    const observer = new ResizeObserver(() => {
      if (!follow.current || !scroller.current) return
      own.current = true
      pinColumn(scroller.current)
      follow.current = true
      own.current = false
    })
    observer.observe(node)
    if (content) observer.observe(content)
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      node.removeEventListener('scroll', onScroll)
    }
  }, [])

  return { scroller, log }
}

function Bubble(props: { entry: TraceEntry }) {
  const role = chatRole(props.entry.detail)
  const text = chatText(props.entry.detail) || props.entry.title
  const note = role === 'host' ? chatNote(props.entry.detail) : ''
  return (
    <p className={`bubble ${bubbleClass(role)}`}>
      <span>{roleLabel(role)}</span>
      {text}
      {note ? <small className="bubble-note">{note}</small> : null}
    </p>
  )
}

function bubbleClass(role: ChatRole): string {
  if (role === 'player') return 'from-player'
  if (role === 'judge') return 'from-judge'
  return 'from-host'
}

function chatRole(detail: unknown): ChatRole {
  if (detail && typeof detail === 'object' && 'role' in detail) {
    const role = detail.role
    if (role === 'host' || role === 'player' || role === 'judge') return role
  }
  return 'host'
}

function chatText(detail: unknown): string {
  if (detail && typeof detail === 'object' && 'text' in detail && typeof detail.text === 'string') {
    return detail.text
  }
  return ''
}

function chatNote(detail: unknown): string {
  if (detail && typeof detail === 'object' && 'note' in detail && typeof detail.note === 'string') {
    return detail.note
  }
  return ''
}

function roleLabel(role: ChatRole): string {
  if (role === 'player') return 'Услышано'
  if (role === 'judge') return 'Оценка'
  return 'Ведущая'
}
