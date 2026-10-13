/** Server-side audio references only. No PCM, transcript or persistent state. */
export type AudioReference = { itemId: string; sessionGeneration: number }
export type AudioItemReady = { ready: true; ref: AudioReference } | { ready: false; reason: string }
type RecordState = { stopped: boolean; committed: boolean; audio: boolean | null; deleted: boolean; pins: number }

export class AudioItems {
  private items = new Map<string, RecordState>()
  private waiters = new Set<() => void>()
  generation = 0

  reset(): void {
    this.generation += 1
    this.items.clear()
    for (const notify of [...this.waiters]) notify()
  }

  observe(event: Record<string, unknown>): void {
    const item = event.item as Record<string, unknown> | undefined
    const id = typeof event.item_id === 'string' ? event.item_id : typeof item?.id === 'string' ? item.id : ''
    if (!id) return
    const type = event.type
    if (!['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed',
      'conversation.item.added', 'conversation.item.created', 'conversation.item.done', 'conversation.item.deleted'].includes(String(type))) return
    const record = this.items.get(id) ?? { stopped: false, committed: false, audio: null, deleted: false, pins: 0 }
    if (type === 'input_audio_buffer.speech_stopped') record.stopped = true
    if (type === 'input_audio_buffer.committed') record.committed = true
    if (type === 'conversation.item.deleted') record.deleted = true
    if (item) {
      record.audio = item.type === 'message' && item.role === 'user' && Array.isArray(item.content) &&
        item.content.some((part) => part && typeof part === 'object' && part.type === 'input_audio')
      if (record.audio) record.committed = true
    }
    this.items.delete(id)
    this.items.set(id, record)
    this.trim()
    for (const notify of [...this.waiters]) notify()
  }

  reference(itemId: string): AudioReference { return { itemId, sessionGeneration: this.generation } }

  status(ref: AudioReference): AudioItemReady {
    if (ref.sessionGeneration !== this.generation) return { ready: false, reason: 'session-changed' }
    const item = this.items.get(ref.itemId)
    if (item?.deleted) return { ready: false, reason: 'item-deleted' }
    if (item?.audio === false) return { ready: false, reason: 'not-user-audio' }
    return item?.stopped && item.committed
      ? { ready: true, ref }
      : { ready: false, reason: 'item-not-ready' }
  }

  pin(ref: AudioReference): () => void {
    if (ref.sessionGeneration !== this.generation) return () => {}
    const item = this.items.get(ref.itemId)
    if (!item) return () => {}
    item.pins += 1
    return () => { item.pins = Math.max(0, item.pins - 1); this.trim() }
  }

  wait(ref: AudioReference, deadlineAt: number, signal?: AbortSignal): Promise<AudioItemReady> {
    const initial = this.status(ref)
    if (initial.ready || initial.reason !== 'item-not-ready') return Promise.resolve(initial)
    if (signal?.aborted) return Promise.resolve({ ready: false, reason: 'cancelled' })
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: AudioItemReady) => {
        if (timer !== undefined) clearTimeout(timer)
        this.waiters.delete(check)
        signal?.removeEventListener('abort', abort)
        resolve(result)
      }
      const check = () => {
        const result = this.status(ref)
        if (result.ready || result.reason !== 'item-not-ready') finish(result)
      }
      const abort = () => finish({ ready: false, reason: 'cancelled' })
      this.waiters.add(check)
      signal?.addEventListener('abort', abort, { once: true })
      if (Number.isFinite(deadlineAt)) timer = setTimeout(() => finish({ ready: false, reason: 'ready-timeout' }), Math.max(0, deadlineAt - performance.now()))
      check()
    })
  }

  private trim(): void {
    for (const [id, item] of this.items) {
      if (this.items.size <= 200) break
      if (!item.pins) this.items.delete(id)
    }
  }
}
