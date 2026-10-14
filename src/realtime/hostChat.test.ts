import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import twoItems from './fixtures/clarify-two-items.json'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; wireOpen: boolean; handleMessage(raw: string): void }

let client: RealtimeClient
let feed: (event: object) => void
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: vi.fn(), onmessage: null }
  opened.wireOpen = true
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('чат ведущей: одна реплика — одна строка', () => {
  it('ответ из двух сказанных реплик (живая игра 14.10, 20:40:11): обе в чате ровно по разу', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('clarify', 28, 'Попроси выбрать ещё раз.')
    for (const event of twoItems) feed(event)
    const host = getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === 'Ведущая').map((e) => (e.detail as { text: string }).text)
    expect(host).toEqual([
      'Хорошо, давайте уточним выбор, чтобы не пропускать снова.',
      'Вася, выбери ячейку ещё раз, пожалуйста.',
    ])
  })
})
