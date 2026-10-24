import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDebugDump } from '../debug/trace.ts'
import type { StoredLogEntry } from '../debug/logDb.ts'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import { outputFlushWaitMs } from './playback.ts'
import { eventsFromDebugDump, translateReplayInbound, type ReplayWire } from './replayDump.ts'
import { qwenTranslateOutbound } from './qwenWire.ts'

/**
 * Прогонщик записанных потоков без ключа API.
 * Новый сценарий из живой партии: секция `## trace` дампа → `eventsFromDebugDump`,
 * перед пачкой — шаг `tool` / `speech` / `interrupt` (в дампе это строки `out`).
 * Как именно — docs/DEBUG.md, раздел «Поток из дампа».
 * Grok шлёт ту же форму, что OpenAI: отдельного провода здесь нет.
 * Счёт партии этот файл не проверяет: «строго последняя разборчивая» — answerTurn.test.ts.
 */

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; wireOpen: boolean; handleMessage(raw: string): void }

type ReplayStep =
  | { kind: 'tool'; purpose: string; turn: number; name: string; instructions: string }
  | { kind: 'speech'; purpose: string; turn: number; instructions: string; expect?: string }
  | { kind: 'interrupt'; reason: string }
  | { kind: 'in'; events: readonly object[]; wire?: ReplayWire }

const question = 'У цветковых растений мужские половые клетки сами никуда не идут – их несут эти мелкие зёрна: на лапках пчелы, на ветру или прямо в нос аллергику.'
/** 13 содержательных слов из 19 — меньше порога 75% (около 70%). */
const readAtSeventy = 'У цветковых растений мужские половые клетки сами никуда не идут – их несут эти мелкие зёрна на лапках'
/** Почти весь вопрос, без последнего слова «аллергику»: мешок слов уже ≥75%, порядок последнего — нет. */
const readWithoutLastWord = 'У цветковых растений мужские половые клетки сами никуда не идут – их несут эти мелкие зёрна: на лапках пчелы, на ветру или прямо в нос.'

let client: RealtimeClient
let sent: Array<Record<string, unknown>>
let feed: (event: object) => void
const toolCalls: Array<{ purpose: string; turn: number; name: string | null }> = []
const transcripts: Array<{ itemId: string; text: string }> = []
const finished: string[] = []

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  sent = []
  toolCalls.length = 0
  transcripts.length = 0
  finished.length = 0
  client.onToolCall = (call, purpose, turn) => toolCalls.push({ purpose, turn, name: call?.name ?? null })
  client.onTranscript = ({ itemId, text }) => transcripts.push({ itemId, text })
  client.onAudioFinished = ({ purpose }) => finished.push(purpose)
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>), onmessage: null }
  opened.wireOpen = true
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function selectCall(name: string): Record<string, unknown> {
  return { id: 'i1', type: 'function_call', status: 'completed', name, call_id: 'call_1', arguments: '{"theme":"Сказки","price":10}' }
}

function play(steps: readonly ReplayStep[]): void {
  for (const step of steps) {
    if (step.kind === 'tool') client.requestTool(step.purpose, step.turn, step.name, step.instructions)
    else if (step.kind === 'speech') client.requestSpeech(step.purpose, step.turn, step.instructions, step.expect)
    else if (step.kind === 'interrupt') client.interruptSpeech(step.reason)
    else {
      for (const event of step.events) {
        const inbound = translateReplayInbound(event, step.wire ?? 'openai')
        if (inbound) feed(inbound)
      }
    }
  }
}

const notesSince = (cursor: number): string[] => getTrace().filter((entry) => entry.id > cursor && entry.kind === 'note').map((entry) => entry.title)

describe('дамп → события', () => {
  it('из ## trace берёт только входящие объекты с type и без дельт', () => {
    const event = { type: 'response.done', response: { id: 'q1', metadata: { purpose: 'select', turn: '5' } } }
    const stored: StoredLogEntry[] = [
      { source: 'local', at: '2026-10-24T08:00:00.000Z', kind: 'in', title: 'response.done', detail: JSON.stringify(event) },
      { source: 'local', at: '2026-10-24T08:00:01.000Z', kind: 'in', title: 'response.output_audio_transcript.delta', detail: JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'а' }) },
      { source: 'local', at: '2026-10-24T08:00:02.000Z', kind: 'note', title: 'заметка' },
      { source: 'local', at: '2026-10-24T08:00:03.000Z', kind: 'out', title: 'response.create', detail: JSON.stringify({ type: 'response.create' }) },
      { source: 'remote', clientId: 'p', name: 'Игрок', at: '2026-10-24T08:00:04.000Z', kind: 'in', title: 'response.done', detail: JSON.stringify({ type: 'response.done', response: { id: 'remote' } }) },
    ]
    expect(eventsFromDebugDump(formatDebugDump({ path: 'test', context: { players: [] } }, stored))).toEqual([event])
  })
})

describe('чужой ход', () => {
  it('OpenAI: done с чужим turn не принимается, свой turn — да', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    play([
      { kind: 'tool', purpose: 'select', turn: 5, name: 'selectQuestion', instructions: 'выбери' },
      { kind: 'in', events: [{ type: 'response.done', response: { id: 'q1', status: 'completed', output: [selectCall('selectQuestion')], metadata: { purpose: 'select', turn: '3' } } }] },
    ])
    expect(toolCalls).toEqual([])
    expect(notesSince(cursor).some((title) => title.includes('поздний selectQuestion turn=3'))).toBe(true)
    play([
      { kind: 'in', events: [{ type: 'response.done', response: { id: 'q2', status: 'completed', output: [selectCall('selectQuestion')], metadata: { purpose: 'select', turn: '5' } } }] },
    ])
    expect(toolCalls).toEqual([{ purpose: 'select', turn: 5, name: 'selectQuestion' }])
  })

  it('Qwen: без metadata ход берётся из response.created; created до запроса — чужой', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    play([
      { kind: 'in', events: [{ type: 'response.created', response: { id: 'old', status: 'in_progress', output: [] } }] },
      { kind: 'tool', purpose: 'select', turn: 5, name: 'selectQuestion', instructions: 'выбери' },
      { kind: 'in', events: [{ type: 'response.done', response: { id: 'old', status: 'completed', output: [selectCall('selectQuestion')] } }] },
    ])
    expect(toolCalls).toEqual([])
    expect(notesSince(cursor).some((title) => title.includes('без метки хода'))).toBe(true)
    play([
      { kind: 'in', events: [{ type: 'response.created', response: { id: 'own', status: 'in_progress', output: [] } }] },
      { kind: 'in', events: [{ type: 'response.done', response: { id: 'own', status: 'completed', output: [selectCall('selectQuestion')] } }] },
    ])
    expect(toolCalls).toEqual([{ purpose: 'select', turn: 5, name: 'selectQuestion' }])
  })

  it('Gemini: done функции без metadata и без response.created не применяется', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    // Так сейчас испускает geminiWire.onTool: response.done, id, function_call, без metadata и без created.
    play([
      { kind: 'tool', purpose: 'select', turn: 5, name: 'selectQuestion', instructions: 'выбери' },
      { kind: 'in', wire: 'gemini', events: [{ type: 'response.done', response: { id: 'gem-1', status: 'completed', output: [selectCall('selectQuestion')] } }] },
    ])
    expect(toolCalls).toEqual([])
    expect(notesSince(cursor).some((title) => title.includes('без метки хода'))).toBe(true)
  })
})

describe('поздняя расшифровка и два распознавания', () => {
  it('поздняя расшифровка доходит до onTranscript один раз, повтор того же itemId — нет', () => {
    play([
      { kind: 'in', events: [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late', transcript: 'пылесосел' }] },
      { kind: 'in', events: [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late', transcript: 'другая фраза' }] },
    ])
    expect(transcripts).toEqual([{ itemId: 'late', text: 'пылесосел' }])
  })

  it('Qwen: text+stash переводится до клиента, и поздний completed с полем text тоже доходит', () => {
    play([
      {
        kind: 'in',
        wire: 'qwen',
        events: [{
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'q-late',
          text: 'поздно верно',
        }],
      },
    ])
    expect(transcripts).toEqual([{ itemId: 'q-late', text: 'поздно верно' }])
    const translated = translateReplayInbound({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'q-late',
      text: 'поздно ',
      stash: 'верно',
    }, 'qwen')
    expect(translated).toMatchObject({ type: 'conversation.item.input_audio_transcription.delta', transcript: 'поздно верно' })
  })

  it('два itemId приходят по порядку, повтор первого не затирает и не зовёт снова', () => {
    play([
      { kind: 'in', events: [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'пылесосел' }] },
      { kind: 'in', events: [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'нет, Бетельгейзе' }] },
      { kind: 'in', events: [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'пыль' }] },
    ])
    expect(transcripts).toEqual([
      { itemId: 'a', text: 'пылесосел' },
      { itemId: 'b', text: 'нет, Бетельгейзе' },
    ])
  })
})

describe('отмена', () => {
  it('OpenAI отменяет по response_id; response_cancel_not_active в trace не пишется', () => {
    play([
      { kind: 'speech', purpose: 'buzzCall', turn: 3, instructions: 'Дай Васе слово' },
      { kind: 'in', events: [{ type: 'response.created', response: { id: 'buzz', metadata: { purpose: 'buzzCall', turn: '3' } } }] },
      { kind: 'interrupt', reason: 'игрок заговорил на ответе' },
    ])
    const cancel = sent.filter((event) => event.type === 'response.cancel')
    expect(cancel).toEqual([{ type: 'response.cancel', response_id: 'buzz' }])
    const cursor = getTrace().at(-1)?.id ?? 0
    play([{ kind: 'in', events: [{ type: 'error', error: { code: 'response_cancel_not_active', message: 'no active response' } }] }])
    expect(getTrace().filter((entry) => entry.id > cursor && entry.kind === 'in')).toEqual([])
  })

  it('Qwen: тот же cancel уходит на провод без response_id', () => {
    play([
      { kind: 'speech', purpose: 'buzzCall', turn: 3, instructions: 'Дай Васе слово' },
      { kind: 'in', events: [{ type: 'response.created', response: { id: 'buzz' } }] },
      { kind: 'interrupt', reason: 'игрок заговорил' },
    ])
    const cancel = sent.find((event) => event.type === 'response.cancel')
    expect(cancel).toMatchObject({ type: 'response.cancel', response_id: 'buzz' })
    expect(qwenTranslateOutbound(cancel ?? {}).events).toEqual([{ type: 'response.cancel' }])
  })
})

describe('чтение на 70%', () => {
  it('доля слов ниже 75% не заканчивает чтение: один повтор', async () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    play([{ kind: 'speech', purpose: 'read', turn: 63, instructions: question, expect: question }])
    play([
      { kind: 'in', events: [
        { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [], metadata: { purpose: 'read', turn: '63', take: '1' } } },
        { type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'item_1', transcript: readAtSeventy },
      ] },
    ])
    await vi.advanceTimersByTimeAsync(outputFlushWaitMs + 50)
    expect(finished).toEqual([])
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(2)
    expect(notesSince(cursor).some((title) => title.startsWith('не та фраза'))).toBe(true)
    expect(notesSince(cursor).some((title) => title.startsWith('модель не прочитала'))).toBe(false)
  })

  it('без последнего слова чтение не заканчивается; повтор с последним словом по порядку — да', async () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const meta = { purpose: 'read', turn: '64', take: '1' }
    play([{ kind: 'speech', purpose: 'read', turn: 64, instructions: question, expect: question }])
    play([{ kind: 'in', events: [
      { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [], metadata: meta } },
      { type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'item_1', transcript: readWithoutLastWord },
    ] }])
    await vi.advanceTimersByTimeAsync(outputFlushWaitMs + 50)
    expect(finished).toEqual([])
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(2)
    expect(notesSince(cursor).some((title) => title.startsWith('не та фраза'))).toBe(true)
    play([{ kind: 'in', events: [
      { type: 'response.created', response: { id: 'r2', status: 'in_progress', output: [], metadata: { ...meta, take: '2' } } },
      { type: 'output_audio_buffer.started', response_id: 'r2' },
      { type: 'response.output_audio_transcript.done', response_id: 'r2', item_id: 'item_2', transcript: question },
      { type: 'output_audio_buffer.stopped', response_id: 'r2' },
    ] }])
    await vi.advanceTimersByTimeAsync(3000)
    expect(finished).toEqual(['read'])
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(2)
    expect(notesSince(cursor).some((title) => title.startsWith('модель не прочитала'))).toBe(false)
  })
})
