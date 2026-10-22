import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; wireOpen: boolean; handleMessage(raw: string): void }

/**
 * Живая партия 22 октября, дамп 16-18-34: DashScope не эхомит metadata (purpose/turn)
 * в response.done — каждый вызов функции прилетал без метки, клиент отдавал turn=-1
 * и контроллер отбрасывал его как поздний. Здесь проверяем атрибуцию: вызов без метки
 * связывается с отправкой через response.created, чужие и неопознанные — отбрасываются,
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
    feed({ type: 'response.created', response: { id: 'q1' } })
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [] } })
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    // Потерянный текст в чат не публикуется.
    expect(notesFrom(cursor).some((n) => n.includes('без вызова функции'))).toBe(true)
    // Второй — тоже текст: отдаём ходу нулевой вызов.
    feed({ type: 'response.created', response: { id: 'q2' } })
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [] } })
    expect(calls).toEqual([{ purpose: 'select', call: null, turn: 5 }])
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
  })

  it('оценке текст вместо функции нулевым вызовом не форсится — ждём штатный таймаут', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ purpose: string; call: unknown }> = []
    client.onToolCall = (call, purpose) => calls.push({ purpose, call })
    client.requestTool('judge', 7, 'submitAnswerJudgment', 'оцени')
    feed({ type: 'response.created', response: { id: 'q1' } })
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [] } })
    feed({ type: 'response.created', response: { id: 'q2' } })
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
    feed({ type: 'response.created', response: { id: 'q1' } })
    feed(done)
    feed(done)
    expect(onToolCall).not.toHaveBeenCalled()
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    feed({ type: 'response.created', response: { id: 'q2' } })
    feed({ type: 'response.done', response: { id: 'q2', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })

  it('чужой инструмент не принимается за запрошенный выбор — повторяем ожидаемый', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    feed({ type: 'response.created', response: { id: 'q1' } })
    feed({ type: 'response.done', response: { id: 'q1', status: 'completed', output: [selectCall('auctionBid')] } })
    expect(onToolCall).not.toHaveBeenCalled()
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
    feed({ type: 'response.created', response: { id: 'q2' } })
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

  it('created и done старой речи после запроса функции не расходуют повтор инструмента', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const calls: Array<{ purpose: string }> = []
    client.onToolCall = (_call, purpose) => calls.push({ purpose })
    client.requestSpeech('clarify', 5, 'Попроси выбрать ещё раз')
    const stray = { id: 's1', status: 'completed', output: [{ id: 'm1', type: 'message', content: [{ type: 'output_audio', transcript: 'Тема — Сказки' }] }] }
    client.requestTool('judge', 8, 'submitAnswerJudgment', 'оцени')
    feed({ type: 'response.created', response: { id: 's1' } })
    feed({ type: 'response.done', response: stray })
    expect(calls).toEqual([])
    expect(notesFrom(cursor).some((n) => n.includes('повторяю ход'))).toBe(false)
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2)
  })

  it('created старой оценки после нового запроса не превращает старый вердикт в новый', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('judge', 41, 'submitAnswerJudgment', 'первый ответ')
    client.requestTool('judge', 42, 'submitAnswerJudgment', 'второй ответ')
    feed({ type: 'response.created', response: { id: 'old' } })
    feed({ type: 'response.done', response: { id: 'old', status: 'completed', output: [selectCall('submitAnswerJudgment')] } })
    expect(onToolCall).not.toHaveBeenCalled()
    feed({ type: 'response.created', response: { id: 'new' } })
    feed({ type: 'response.done', response: { id: 'new', status: 'completed', output: [selectCall('submitAnswerJudgment')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'submitAnswerJudgment' }), 'judge', 42)
  })

  it('не угадывает владельца unmarked done без response.created', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('judge', 42, 'submitAnswerJudgment', 'оцени')
    feed({ type: 'response.done', response: { id: 'unknown', status: 'completed', output: [selectCall('submitAnswerJudgment')] } })
    expect(onToolCall).not.toHaveBeenCalled()
    feed({ type: 'response.created', response: { id: 'own' } })
    feed({ type: 'response.done', response: { id: 'own', status: 'completed', output: [selectCall('submitAnswerJudgment')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'submitAnswerJudgment' }), 'judge', 42)
  })

  it('ответ с меткой хода и чужой функцией повторяет ожидаемый вызов', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    feed({
      type: 'response.done',
      response: {
        id: 'marked',
        status: 'completed',
        metadata: { purpose: 'select', turn: '5' },
        output: [selectCall('auctionBid')],
      },
    })
    expect(onToolCall).not.toHaveBeenCalled()
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(2)
    feed({
      type: 'response.done',
      response: {
        id: 'marked-2',
        status: 'completed',
        metadata: { purpose: 'select', turn: '5' },
        output: [selectCall('selectQuestion')],
      },
    })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })

  it('ошибка чужой отправки не валит текущий ход, ошибка без id — валит', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    const own = sent.find((event) => event.type === 'response.create')
    client.requestSpeech('announce', 6, 'Скажи итог')
    const speech = sent.filter((event) => event.type === 'response.create').at(-1)
    client.requestTool('select', 7, 'selectQuestion', 'ещё раз')
    feed({ type: 'error', error: { event_id: speech?.event_id, message: 'server had an error' } })
    expect(onToolCall).not.toHaveBeenCalled()
    feed({ type: 'error', error: { event_id: own?.event_id, message: 'server had an error' } })
    expect(onToolCall).not.toHaveBeenCalled()
    feed({ type: 'error', error: { message: 'server had an error' } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(null, 'select', 7)
  })

  it('ответ isolated-вызова не пишется в историю, обычный — пишется один раз', () => {
    client.onToolCall = () => {}
    client.requestTool('judge', 1, 'submitAnswerJudgment', 'оцени', true)
    feed({ type: 'response.created', response: { id: 'iso' } })
    feed({ type: 'response.done', response: { id: 'iso', status: 'completed', output: [selectCall('submitAnswerJudgment')] } })
    client.sendToolOutput('call_1', { accepted: true })
    expect(sent.some((event) => event.type === 'conversation.item.create')).toBe(false)
    client.requestTool('select', 2, 'selectQuestion', 'выбери')
    feed({ type: 'response.created', response: { id: 'plain' } })
    feed({
      type: 'response.done',
      response: { id: 'plain', status: 'completed', output: [{ ...selectCall('selectQuestion'), call_id: 'call_2' }] },
    })
    client.sendToolOutput('call_1', { accepted: true })
    client.sendToolOutput('call_2', { accepted: true })
    client.sendToolOutput('call_2', { accepted: true })
    const outputs = sent.filter((event) => event.type === 'conversation.item.create')
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.item).toMatchObject({ call_id: 'call_2' })
  })

  it('обрыв речи не отменяет ожидающий инструмент', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    client.interruptSpeech('игрок заговорил')
    feed({ type: 'response.created', response: { id: 'own' } })
    feed({ type: 'response.done', response: { id: 'own', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })

  it('новая реплика после инструмента не принимает его старый вызов', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    client.requestSpeech('announce', 6, 'Скажи итог')
    feed({ type: 'response.created', response: { id: 'stale' } })
    feed({ type: 'response.done', response: { id: 'stale', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).not.toHaveBeenCalled()
  })

  it('ошибка конкретной отправки до created снимает только её место в очереди', () => {
    const onToolCall = vi.fn()
    client.onToolCall = onToolCall
    client.requestTool('select', 5, 'selectQuestion', 'выбери')
    const request = sent.find((e) => e.type === 'response.create')
    feed({ type: 'error', error: { event_id: request?.event_id, message: 'unsupported output modality' } })
    feed({ type: 'response.created', response: { id: 'audio-retry' } })
    feed({ type: 'response.done', response: { id: 'audio-retry', status: 'completed', output: [selectCall('selectQuestion')] } })
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'selectQuestion' }), 'select', 5)
  })
})
