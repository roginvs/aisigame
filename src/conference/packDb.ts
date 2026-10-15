const DB_NAME = 'aisigame.packs'
const STORE_NAME = 'packs'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

export async function getPack(hash: string): Promise<Uint8Array | null> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(hash)
      request.onerror = () => reject(request.error ?? new Error('get failed'))
      request.onsuccess = () => {
        const value: unknown = request.result
        if (!value) {
          resolve(null)
          return
        }
        if (value instanceof Uint8Array) {
          resolve(value)
          return
        }
        if (value instanceof ArrayBuffer) {
          resolve(new Uint8Array(value))
          return
        }
        resolve(null)
      }
    })
  } finally {
    db.close()
  }
}

export async function putPack(hash: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put(bytes, hash)
      tx.onerror = () => reject(tx.error ?? new Error('put failed'))
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'))
      tx.oncomplete = () => resolve()
    })
  } finally {
    db.close()
  }
}

export async function deletePack(hash: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(hash)
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'))
      tx.onabort = () => reject(tx.error ?? new Error('delete aborted'))
      tx.oncomplete = () => resolve()
    })
  } finally {
    db.close()
  }
}
