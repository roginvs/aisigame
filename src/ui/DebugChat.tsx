import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getTrace, subscribeTrace, type ChatRole, type TraceEntry } from '../debug/trace.ts'
import type { ConferenceChatLine, ConferenceConversationLine } from '../conference/messages.ts'
import { chatPinKey, isAtTail, pinColumn } from './chatScroll.ts'

export function ConversationChat(props?: {
  conversation?: ConferenceConversationLine[]
  chat?: ConferenceChatLine[]
  onSendChat?: (text: string) => void
  composerLabel?: string
}) {
  const entries = useSyncExternalStore(subscribeTrace, getTrace, getTrace)
  const traceBubbles = entries.filter((entry) => entry.kind === 'chat')
  const bubbles =
    props?.conversation && props.conversation.length > 0
      ? props.conversation.map((line, index) => ({
          id: index,
          kind: 'chat' as const,
          at: '',
          title: roleLabel(line.role),
          detail: { role: line.role, text: line.text },
        }))
      : traceBubbles
  const [draft, setDraft] = useState('')
  const [scrollerRef, logRef] = usePinColumn(chatPinKey(bubbles))
  return (
    <aside className="chat-column" aria-label="Разговор">
      <div className="chat-head">
        <div>
          <p className="eyebrow">Разговор</p>
          <p className="chat-hint">Реплики ведущей, игроков и оценка.</p>
        </div>
      </div>
      <div className="chat-scroll" ref={scrollerRef}>
        <div className="chat-log" ref={logRef}>
          {bubbles.length === 0 ? <p className="chat-hint">Пока тишина.</p> : null}
          {bubbles.map((entry) => (
            <Bubble key={entry.id} entry={entry} />
          ))}
          {props?.chat?.map((line, index) => (
            <p key={`${line.name}-${index}`} className="bubble from-player bubble-typed">
              <span>Чат · {line.name}</span>
              {line.text}
            </p>
          ))}
        </div>
      </div>
      {props?.onSendChat ? (
        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault()
            const text = draft.trim()
            if (!text) return
            props.onSendChat?.(text)
            setDraft('')
          }}
        >
          <label className="visually-hidden" htmlFor="chat-compose">
            {props.composerLabel ?? 'Сообщение в чат'}
          </label>
          <input
            id="chat-compose"
            type="text"
            value={draft}
            placeholder="Сообщение в чат…"
            autoComplete="off"
            enterKeyHint="send"
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="ghost">
            <span aria-hidden="true">&#8593;</span>
            <span>Отправить</span>
          </button>
        </form>
      ) : null}
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

  return [scroller, log] as const
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
