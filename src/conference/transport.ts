import type { ConferenceMessage } from './messages.ts'
import { isConferenceMessage } from './messages.ts'

export interface ConferenceTransport {
  send(message: ConferenceMessage): void
  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void
  close(): void
}

export function conferenceChannelName(roomId: string): string {
  return `aisigame.conference.${roomId}`
}

const seenRelayIds = new Set<string>()

type RelayEnvelope = {
  id: string
  senderId: string
  message: ConferenceMessage
}

function relayStorageKey(channelName: string): string {
  return `${channelName}.relay`
}

function publishRelay(channelName: string, envelope: RelayEnvelope): void {
  try {
    localStorage.setItem(relayStorageKey(channelName), JSON.stringify(envelope))
  } catch {
    // localStorage может быть недоступен — остаётся BroadcastChannel.
  }
}

export class BroadcastChannelTransport implements ConferenceTransport {
  private readonly channel: BroadcastChannel
  private readonly channelName: string
  private readonly onStorage: (event: StorageEvent) => void
  private readonly onChannel: (event: MessageEvent) => void
  private readonly senderId = crypto.randomUUID()

  constructor(roomId: string) {
    this.channelName = conferenceChannelName(roomId)
    this.channel = new BroadcastChannel(this.channelName)
    this.onStorage = (event: StorageEvent) => {
      if (event.key !== relayStorageKey(this.channelName) || !event.newValue) return
      try {
        this.receive(JSON.parse(event.newValue))
      } catch {
        // ignore malformed relay
      }
    }
    this.onChannel = (event: MessageEvent) => this.receive(event.data)
    window.addEventListener('storage', this.onStorage)
    this.channel.addEventListener('message', this.onChannel)
  }

  private handlers = new Set<(message: ConferenceMessage, senderId: string) => void>()

  send(message: ConferenceMessage): void {
    const envelope: RelayEnvelope = { id: crypto.randomUUID(), senderId: this.senderId, message }
    this.channel.postMessage(envelope)
    publishRelay(this.channelName, envelope)
  }

  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    window.removeEventListener('storage', this.onStorage)
    this.channel.removeEventListener('message', this.onChannel)
    this.handlers.clear()
    this.channel.close()
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const envelope = value as { id?: unknown; message?: unknown }
    if (typeof envelope.id !== 'string' || seenRelayIds.has(envelope.id)) return
    if (typeof (envelope as { senderId?: unknown }).senderId !== 'string') return
    if (!isConferenceMessage(envelope.message)) return
    seenRelayIds.add(envelope.id)
    if (seenRelayIds.size > 4096) {
      const oldest = seenRelayIds.values().next().value
      if (typeof oldest === 'string') seenRelayIds.delete(oldest)
    }
    for (const handler of this.handlers) handler(envelope.message, (envelope as { senderId: string }).senderId)
  }
}
