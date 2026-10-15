import { isConferenceMessage, validConferenceState, type ConferenceMessage, type ConferenceSnapshot, type ConferenceState } from './messages.ts'
import { snapshotFromState } from './stateProtocol.ts'

/** Что делать с пришедшим `snapshot`/`partialUpdate`. */
export type ReceivedStep =
  | { kind: 'apply'; state: ConferenceState; revision: number; changed: boolean }
  | { kind: 'skip' }
  | { kind: 'needFull' }

/**
 * «Полученное состояние» из сети — одна сборка для гостя и мастера: полный снимок или
 * изменение поверх своей ревизии, проверка формы. Решения о мастере/сборке — у вызывающего.
 */
export class ReceivedState {
  state: ConferenceState | null = null
  revision: number | null = null

  next(message: ConferenceMessage): ReceivedStep {
    if (message.type === 'snapshot') {
      if (this.revision !== null && message.revision < this.revision) return { kind: 'skip' }
      const { type: _type, authorityToken: _token, revision, sentAt: _sentAt, ...state } = message as typeof message & { sentAt?: number }
      return { kind: 'apply', state: state as ConferenceState, revision, changed: true }
    }
    if (message.type === 'partialUpdate') {
      if (this.revision !== null && message.revision < this.revision) return { kind: 'skip' }
      if (this.revision === message.revision && message.revision !== message.baseRevision) return { kind: 'skip' }
      if (!this.state || this.revision !== message.baseRevision) return { kind: 'needFull' }
      const state = { ...this.state, ...message.changes }
      if (!validConferenceState(state)) return { kind: 'needFull' }
      return { kind: 'apply', state, revision: message.revision, changed: Object.keys(message.changes).length > 0 }
    }
    return { kind: 'skip' }
  }

  commit(step: Extract<ReceivedStep, { kind: 'apply' }>): void {
    this.state = step.state
    this.revision = step.revision
  }

  reset(): void {
    this.state = null
    this.revision = null
  }

  snapshot(): ConferenceSnapshot | null {
    return this.state ? snapshotFromState(this.state) : null
  }
}

/**
 * Мастер получает своё «полученное состояние» тем же путём, что гость: Jitsi своё же
 * сообщение отправителю не возвращает, поэтому петля — ровно те байты, что ушли в
 * транспорт (`JSON.stringify` → `JSON.parse` → `isConferenceMessage` → `ReceivedState`),
 * асинхронно, следующей задачей. Пропущенное изменение просит полный снимок.
 */
export class LoopbackStateReceiver {
  private readonly received = new ReceivedState()
  private closed = false

  private readonly onSnapshot: (snapshot: ConferenceSnapshot) => void
  private readonly requestFull: () => void

  constructor(onSnapshot: (snapshot: ConferenceSnapshot) => void, requestFull: () => void) {
    this.onSnapshot = onSnapshot
    this.requestFull = requestFull
  }

  deliver(wire: string): void {
    window.setTimeout(() => {
      if (this.closed) return
      let message: unknown
      try { message = JSON.parse(wire) } catch { return }
      if (!isConferenceMessage(message)) return
      const step = this.received.next(message)
      if (step.kind === 'needFull') { this.requestFull(); return }
      if (step.kind !== 'apply') return
      this.received.commit(step)
      if (!step.changed) return
      const snapshot = this.received.snapshot()
      if (snapshot) this.onSnapshot(snapshot)
    }, 0)
  }

  close(): void {
    this.closed = true
  }
}
