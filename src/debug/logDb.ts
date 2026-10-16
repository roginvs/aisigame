import { debugLogFlushBatch, debugLogFlushMs } from '../options.ts'

/**
 * Полный отладочный лог партии в IndexedDB, без ограничения размера.
 * Один слот на браузер, жизненный цикл как у сохранённой игры: новая игра и
 * выход стирают его. Пишется пачками; если IndexedDB нет или кончилась квота,
 * лог тихо остаётся только в памяти (кольцо в trace.ts).
 */
export type StoredLogEntry = {
  source: 'local' | 'remote'
  clientId?: string
  name?: string
  at: string
  kind: string
  title: string
  /** Уже сериализованная деталь (JSON у local, строка с провода у remote). */
  detail?: string
}

export type LogBackend = {
  append(entries: readonly StoredLogEntry[]): Promise<void>
  readAll(): Promise<StoredLogEntry[]>
  clear(): Promise<void>
}

const DB_NAME = 'aisigame.debug'
const STORE_NAME = 'log'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('idb request failed'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb tx failed'))
    tx.onabort = () => reject(tx.error ?? new Error('idb tx aborted'))
  })
}

export function indexedDbBackend(): LogBackend | null {
  if (typeof indexedDB === 'undefined') return null
  let dbPromise: Promise<IDBDatabase> | null = null
  const open = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME, { autoIncrement: true })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    }).catch((error: unknown) => {
      dbPromise = null
      throw error
    })
    return dbPromise
  }
  return {
    async append(entries) {
      const db = await open()
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      for (const entry of entries) store.add(entry)
      await done(tx)
    },
    async readAll() {
      const db = await open()
      const tx = db.transaction(STORE_NAME, 'readonly')
      return (await request(tx.objectStore(STORE_NAME).getAll())) as StoredLogEntry[]
    },
    async clear() {
      const db = await open()
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      await done(tx)
    },
  }
}

export type DebugLogStore = {
  push(entry: StoredLogEntry): void
  flush(): Promise<void>
  /** Всё записанное + ещё не сброшенная очередь; null — хранилище недоступно. */
  readAll(): Promise<StoredLogEntry[] | null>
  wipe(): Promise<void>
  /** Последняя ошибка записи (квота и т.п.), для дампа. */
  lastError(): string
}

export function createDebugLogStore(
  backend: LogBackend | null,
  options: { flushMs?: number; batch?: number; schedule?: (fn: () => void, ms: number) => unknown } = {},
): DebugLogStore {
  const flushMs = options.flushMs ?? debugLogFlushMs
  const batch = options.batch ?? debugLogFlushBatch
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let queue: StoredLogEntry[] = []
  let timer = false
  let chain: Promise<void> = Promise.resolve()
  let broken = backend === null
  let error = backend === null ? 'IndexedDB недоступен' : ''
  /** Номер «поколения»: wipe отменяет запись пачек, собранных до него. */
  let generation = 0

  const run = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task).catch((cause: unknown) => {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      if (cause instanceof DOMException && cause.name === 'QuotaExceededError') broken = true
    })
    return chain
  }

  const flush = (): Promise<void> => {
    timer = false
    if (broken || !backend || queue.length === 0) return chain
    const pack = queue
    queue = []
    const gen = generation
    return run(async () => {
      if (gen !== generation) return
      await backend.append(pack)
    })
  }

  return {
    push(entry) {
      if (broken) return
      queue.push(entry)
      if (queue.length >= batch) {
        void flush()
        return
      }
      if (!timer) {
        timer = true
        schedule(() => void flush(), flushMs)
      }
    },
    flush,
    async readAll() {
      if (!backend) return null
      const pending = queue.slice()
      let stored: StoredLogEntry[] | null = null
      await run(async () => {
        stored = await backend.readAll()
      })
      return stored === null ? null : [...(stored as StoredLogEntry[]), ...pending]
    },
    wipe() {
      generation += 1
      queue = []
      if (!backend) return chain
      broken = false
      error = ''
      return run(() => backend.clear())
    },
    lastError: () => error,
  }
}

export const debugLogStore: DebugLogStore = createDebugLogStore(indexedDbBackend())
