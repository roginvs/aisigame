import { describe, expect, it } from 'vitest'
import { createDebugLogStore, type LogBackend, type StoredLogEntry } from './logDb.ts'

function memoryBackend(fail?: () => Error | null): LogBackend & { rows: StoredLogEntry[]; writes: number } {
  const backend = {
    rows: [] as StoredLogEntry[],
    writes: 0,
    async append(entries: readonly StoredLogEntry[]) {
      const error = fail?.()
      if (error) throw error
      backend.writes += 1
      backend.rows.push(...entries)
    },
    async readAll() {
      return backend.rows.slice()
    },
    async clear() {
      backend.rows = []
    },
  }
  return backend
}

const entry = (title: string): StoredLogEntry => ({ source: 'local', at: 't', kind: 'note', title })

describe('debugLogStore', () => {
  it('пишет пачками, без ограничения размера, и читает с несброшенной очередью', async () => {
    const backend = memoryBackend()
    const timers: (() => void)[] = []
    const store = createDebugLogStore(backend, { batch: 1000, schedule: (fn) => timers.push(fn) })
    for (let i = 0; i < 5000; i += 1) store.push(entry(String(i)))
    await store.flush()
    expect(backend.writes).toBe(5)
    store.push(entry('хвост'))
    expect((await store.readAll())?.length).toBe(5001)
    timers.forEach((fn) => fn())
    await store.flush()
    expect(backend.rows.at(-1)?.title).toBe('хвост')
  })

  it('wipe стирает и записанное, и очередь', async () => {
    const backend = memoryBackend()
    const store = createDebugLogStore(backend, { batch: 2, schedule: () => 0 })
    store.push(entry('a'))
    store.push(entry('b'))
    store.push(entry('c'))
    await store.wipe()
    expect(await store.readAll()).toEqual([])
  })

  it('квота: запись прекращается без исключений, ошибка видна', async () => {
    const backend = memoryBackend(() => new DOMException('full', 'QuotaExceededError'))
    const store = createDebugLogStore(backend, { batch: 1, schedule: () => 0 })
    store.push(entry('a'))
    await store.flush()
    store.push(entry('b'))
    expect(store.lastError()).toContain('QuotaExceededError')
    expect(await store.readAll()).toEqual([])
  })

  it('без IndexedDB — null, дамп берёт память', async () => {
    const store = createDebugLogStore(null)
    store.push(entry('a'))
    expect(await store.readAll()).toBeNull()
  })
})
