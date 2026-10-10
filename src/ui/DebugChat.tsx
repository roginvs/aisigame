import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SnapshotFrom } from 'xstate'
import { copyDebugDump, getTrace, subscribeTrace, type ChatRole, type TraceEntry } from '../debug/trace.ts'
import { gameMachine, statePath } from '../game/machine.ts'

export function ConversationChat() {
  const entries = useSyncExternalStore(subscribeTrace, getTrace, getTrace)
  const bubbles = entries.filter((entry) => entry.kind === 'chat')
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    bottom?.scrollIntoView({ block: 'end' })
  }, [bottom, bubbles.length])
  return (
    <aside className="chat-column">
      <div className="chat-head">
        <div>
          <p className="eyebrow">Разговор</p>
          <p className="chat-hint">Реплики ведущей, игроков и оценка.</p>
        </div>
      </div>
      <div className="chat-scroll">
        {bubbles.length === 0 ? <p className="chat-hint">Пока тишина.</p> : null}
        {bubbles.map((entry) => (
          <Bubble key={entry.id} entry={entry} />
        ))}
        <div ref={setBottom} />
      </div>
    </aside>
  )
}

export function TechnicalLog(props: { snapshot: SnapshotFrom<typeof gameMachine>; onNextRound: () => void }) {
  const entries = useSyncExternalStore(subscribeTrace, getTrace, getTrace)
  const [copyLabel, setCopyLabel] = useState('Скопировать дебаг')
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    bottom?.scrollIntoView({ block: 'end' })
  }, [bottom, entries.length])

  async function copy() {
    const ok = await copyDebugDump({
      path: statePath(props.snapshot.value),
      context: props.snapshot.context,
    })
    setCopyLabel(ok ? 'Скопировано' : 'Не скопировалось')
    window.setTimeout(() => setCopyLabel('Скопировать дебаг'), 1600)
  }

  return (
    <aside id="tech-log" className="chat-column tech-column">
      <div className="chat-head tech-head">
        <div>
          <p className="eyebrow">Техническое</p>
          <p className="chat-hint">События и что ведущая сказала на самом деле.</p>
        </div>
        <div className="tech-actions">
          <button type="button" className="ghost" onClick={() => void copy()}>
            {copyLabel}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={props.onNextRound}
            disabled={!props.snapshot.can({ type: 'NEXT_ROUND' })}
          >
            Следующий раунд
          </button>
        </div>
      </div>
      <div className="chat-scroll">
        {entries.length === 0 ? <p className="chat-hint">Пока тишина.</p> : null}
        {entries.map((entry) => (visible(entry) ? <TechRow key={entry.id} entry={entry} /> : null))}
        <div ref={setBottom} />
      </div>
    </aside>
  )
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

function TechRow(props: { entry: TraceEntry }) {
  const { entry } = props
  const when = stamp(entry.at)
  if (entry.kind === 'chat') {
    const role = chatRole(entry.detail)
    const text = chatText(entry.detail) || entry.title
    return (
      <p className="trace-line" title={when}>
        {roleLabel(role)}: {text}
      </p>
    )
  }
  const arrow = entry.kind === 'out' ? '→' : entry.kind === 'in' ? '←' : '•'
  return (
    <p className="trace-line" title={when}>
      {arrow} {entry.title}
    </p>
  )
}

function bubbleClass(role: ChatRole): string {
  if (role === 'player') return 'from-player'
  if (role === 'judge') return 'from-judge'
  return 'from-host'
}

function visible(entry: TraceEntry): boolean {
  return !entry.title.endsWith('.delta')
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

function stamp(iso: string): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString('ru-RU', { hour12: false })
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`
}
