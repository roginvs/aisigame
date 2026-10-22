import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; wireOpen: boolean; handleMessage(raw: string): void }

/**
 * Живая партия 22 октября, дамп 16-18-34: DashScope не эхомит metadata (purpose/turn)
 * в response.done — каждый вызов функции прилетал без метки, клиент отдавал turn=-1
 * и контроллер отбрасывал его как поздний. Здесь проверяем атрибуцию: вызов без метки
 * приписывается ожидающему ходу, чужие (активные на момент запроса) — отбрасываются,
 * ответ текстом вместо функции — один повтор и быстрый отказ ходу.
 */

let client: RealtimeClient
let feed: (event: object) => void
let sent: Array<Record<string, unknown>>
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  sent = []
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: vi.fn((raw: string) => sent.push(JSON.parse(raw))), onmessage: null }
  opened.wireOpen = true
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function selectCall(name: string): Record<string, unknown> {
  return {
    id: 'i1',
    type: 'function_call',
    status: 'completed',
    name,
    call_id: 'call_1',
    arguments: '{"theme":"Сказки","price":10}',
  }
}

const notesFrom = (cursor: number): string[] => getTrace().filter((e) => e.id > cursor).map((e) => e.title)

describe('вызов функции без метки хода (Qwen/DashScope)', () => {
  it('done без metadata приписывается ожидающему ходу, а не turn=-1', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ purpose: string; turn: number; name: string | null }> = []
    client.onToolCall = (call, purpose, turn) => calls.push({ purpose, turn, name: call?.name ?? null })
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    feed({ type: 'response.created', response: { id: 'q1', status: 'in_progress', output: [] } })
    feed({ type: 'function_call_arguments.done', item_id: 'i1', response_id: 'q1' })
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(calls).toEqual([{ purpose: 'select', turn: 5, name: 'selectQuestion' }])
    expect(notesFrom(cursor).some((n) => n.startsWith('поздний'))).toBe(false)
  })

  it('поздний done ответа, активного на момент запроса, отбрасывается по снимку ответов', () => {
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    const calls: Array<{ turn: number }> = []
    client.onToolCall = (_call, _purpose, turn) => calls.push({ turn })
    // q0 создаётся и не завершается до запроса: его поздний done — чужой.
    feed({ type: 'response.created', response: { id: 'q0', status: 'in_progress', output: [] } })
    client.requestTool('select', 6, 'selectQuestion', 'выбери')
    feed({ type: 'response.done', response: { id: 'q0', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(calls).toEqual([])
    expect(notesFrom(0).some((n) => n.includes('без метки хода'))).toBe(true)
  })

  it('ответ текстом вместо функции: один повтор, затем onToolCall(null) для выбора', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ purpose: string; call: unknown; turn: number }> = []
    client.onToolCall = (call, purpose, turn) => calls.push({ purpose, call, turn })
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    // Первый ответ — текст без функции.
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [] } })
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    // Потерянный текст в чат не публикуется.
    expect(notesFrom(cursor).some((n) => n.includes('без вызова функции'))).toBe(true)
    // Второй — тоже текст: отдаём ходу нулевой вызов.
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [] } })
    expect(calls).toEqual([{ purpose: 'select', call: null, turn: 5 }])
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
  })

  it('оценке текст вместо функции нулевым вызовом не форсится — ждём штатный таймаут', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ purpose: string; call: unknown }> = []
    client.onToolCall = (call, purpose) => calls.push({ purpose, call })
    client.requestTool('judge', 7, 'submitAnswerJudgment', 'оцени')
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [] } })
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [] } })
    expect(calls).toEqual([])
    // Паметка пишется, но onToolCall не зовётся: нулевой вердикт — это вердикт.
    expect(notesFrom(cursor).some((n) => n.includes('отдаю ходу'))).toBe(true)
  })

  it('поздний done после смены text на audio не запускает лишний повтор', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    feed({ type: 'response.created', response: { id: 'q1' } })
    feed({ type: 'error', error: { message: 'unsupported output modality' } })
    feed({ type: 'response.created', response: { id: 'q2' } })
    feed({ type: 'response.done', response: { id: 'q1', status: 'cancelled', output: [] } })
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })

  it('дубликат done первого ответа не расходует повтор и не отказывает текущему ходу', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    const done = { type: 'response.done', response: { id: 'q1', status: 'completed', output: [] } }
    feed(done)
    feed(done)
    expect(onToolCall).not.toHaveBeenCalled()
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })

  it('чужой инструмент не принимается за запрошенный выбор — повторяем ожидаемый', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [selectCall('auctionBid')] } })
    expect(onToolCall).not.toHaveBeenCalled()
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })

  it('done с помеченным чужим turn не трогается — путь OpenAI не менялся', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ turn: number }> = []
    client.onToolCall = (_call, _purpose, turn) => calls.push({ turn })
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [selectCall('selectQuestion')], metadata: { purpose: 'select', turn: '3' } } })
    expect(calls).toEqual([])
    expect(notesFrom(cursor).some((n) => n.includes('поздний selectQuestion turn=3'))).toBe(true)
  })

  it('done речи ведущей без метки (Qwen) не считается ответом на инструмент: текст в чат идёт как раньше', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ purpose: string }> = []
    client.onToolCall = (_call, purpose) => calls.push({ purpose })
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    // Реплика-подсказка, ушедшая до запроса: её done — не наш, но она в снимке stale.
    // Отдельно проверяем не-snapshot сценарий: speech активна, done без call дошёл.
    ;(client as unknown as { speech: unknown }).speech = null
    const stray = { id: 's1', status: 'completed', output: [{ id: 'm1', type: 'message', content: [{ type: 'output_audio', transcript: 'Тема — Сказки' }] }] }
    // Чужого снимка нет: s1 не в staleResponses, ждущего чужого ответа нет.
    client.requestTool('judge', 8, 'submitAnswerJudgment', 'оцени')
    feed({ type: 'response.done', response: stray })
    // judge не форсится нулевым вызовом и не републикуется как реплика хода.
    expect(calls).toEqual([])
    expect(notesFrom(cursor).some((n) => n.includes('повторяю ход'))).toBe(true)
  })
})
