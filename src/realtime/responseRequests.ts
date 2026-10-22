type Metadata = { purpose: string; turn: string; requestId: string }
export type ResponseRequest = Metadata & { token: number; eventId: string; cancelled?: boolean }

/** Связывает созданный сервером ответ с конкретной отправкой, в том числе без эха metadata. */
export class ResponseRequests {
  private serial = 0
  private queued: ResponseRequest[] = []
  private responses = new Map<string, ResponseRequest>()

  sent(response: Record<string, unknown>, eventId?: string): ResponseRequest {
    const token = ++this.serial
    const request = { ...metadataOf(response), token, eventId: eventId || `client-response-${token}` }
    this.queued.push(request)
    return request
  }

  created(response: Record<string, unknown>): void {
    const id = typeof response.id === 'string' ? response.id : ''
    if (!id || this.responses.has(id)) return
    const metadata = metadataOf(response)
    const marked = Boolean(metadata.requestId || metadata.purpose || metadata.turn)
    // Ответы без метки связываются в порядке отправки response.create, а не с тем,
    // что ждёт контроллер СЕЙЧАС. Отменённая отправка тоже ждёт своего created/error.
    const index = marked ? this.queued.findIndex((request) =>
      (!metadata.requestId || request.requestId === metadata.requestId) &&
      (!metadata.purpose || request.purpose === metadata.purpose) &&
      (!metadata.turn || request.turn === metadata.turn)) : 0
    if (index < 0) return
    const request = this.queued.splice(index, 1)[0]
    if (!request) return
    this.responses.set(id, request)
    // Завершённые id сохраняются для поздних/дублированных событий; незнакомый id не угадываем.
    if (this.responses.size > 256) this.responses.delete(this.responses.keys().next().value!)
  }

  get(response: Record<string, unknown>): ResponseRequest | undefined {
    return typeof response.id === 'string' ? this.responses.get(response.id) : undefined
  }

  cancel(token: number | null): void {
    if (token === null) return
    const request = this.queued.find((item) => item.token === token) ??
      [...this.responses.values()].find((item) => item.token === token)
    if (request) request.cancelled = true
  }

  rejected(eventId: string): void {
    if (eventId) this.queued = this.queued.filter((request) => request.eventId !== eventId)
  }

  reset(): void {
    this.queued = []
    this.responses.clear()
  }
}

function metadataOf(response: Record<string, unknown>): Metadata {
  const value = response.metadata
  const metadata = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    purpose: typeof metadata.purpose === 'string' ? metadata.purpose : '',
    turn: typeof metadata.turn === 'string' || typeof metadata.turn === 'number' ? String(metadata.turn) : '',
    requestId: typeof metadata.requestId === 'string' ? metadata.requestId : '',
  }
}
