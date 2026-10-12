import {
  CONFERENCE_HISTORY_LIMIT,
  type ConferenceHistoryMessage,
  type ConferenceMessageRing,
  type ConferenceMessageSlot,
  type ConferenceSnapshot,
  type ConferenceState,
  type PartialUpdateMessage,
  type SnapshotMessage,
} from './messages.ts'

import { readMessageRing } from './messageRing.ts'

export { emptyMessageRing } from './messageRing.ts'

export function snapshotFromState(state: ConferenceState): ConferenceSnapshot {
  return { ...gameFields(state), ...readMessageRing(state)! }
}

function gameFields(snapshot: ConferenceSnapshot): Omit<ConferenceSnapshot, keyof ConferenceMessageRing> {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) =>
    !['type', 'authorityToken', 'revision', 'messageIndex'].includes(key) && !/^message\d+$/.test(key),
  )) as Omit<ConferenceSnapshot, keyof ConferenceMessageRing>
}

/** Единственная база дифов мастера; полный снимок всегда рассылается всей комнате. */
export class ConferenceStatePublisher {
  private state: ConferenceState
  private revision = 0
  private authorityToken: string

  constructor(snapshot: ConferenceSnapshot, authorityToken: string) {
    this.authorityToken = authorityToken
    this.state = snapshotFromState(snapshot)
  }

  history(): ConferenceMessageRing {
    return readMessageRing(this.state)!
  }

  update(snapshot: ConferenceSnapshot): PartialUpdateMessage {
    const changes: Partial<ConferenceState> = {}
    for (const [key, value] of Object.entries(gameFields(snapshot))) {
      if (JSON.stringify(value) !== JSON.stringify(this.state[key as keyof ConferenceState])) {
        Object.assign(changes, { [key]: value })
      }
    }
    return this.apply(changes)
  }

  appendMessage(line: ConferenceHistoryMessage): PartialUpdateMessage {
    const index = (this.state.messageIndex + 1) % CONFERENCE_HISTORY_LIMIT
    const changes: Partial<ConferenceState> = { messageIndex: index }
    changes[`message${index}` as ConferenceMessageSlot] = line
    return this.apply(changes)
  }

  full(): SnapshotMessage {
    return { ...this.state, type: 'snapshot', authorityToken: this.authorityToken, revision: this.revision }
  }

  private apply(changes: Partial<ConferenceState>): PartialUpdateMessage {
    const baseRevision = this.revision
    if (Object.keys(changes).length > 0) {
      this.state = Object.assign({}, this.state, changes)
      this.revision++
    }
    return { type: 'partialUpdate', authorityToken: this.authorityToken, baseRevision, revision: this.revision, changes }
  }
}
