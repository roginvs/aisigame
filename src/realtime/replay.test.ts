import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { formatDebugDump } from '../debug/trace.ts'
import type { StoredLogEntry } from '../debug/logDb.ts'
import { getTrace } from '../debug/trace.ts'
import { answerSilenceDecideMs } from '../options.ts'
import { attachController } from '../game/controller.ts'
import { gameMachine, statePath } from '../game/machine.ts'
import type { Question, QuestionPack } from '../game/types.ts'
import { RealtimeClient } from './client.ts'
import { geminiOutboundTurns } from './geminiWire.ts'
import { MockRealtimeClient } from './mockClient.ts'
import { outputFlushWaitMs } from './playback.ts'
import { qwenTranslateOutbound } from './qwenWire.ts'
import { freshGrokTurn, grokInbound } from './grokWire.ts'
import { eventsFromDebugDump, translateReplayInbound, type ReplayWire } from './replayDump.ts'
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))

/**
 * Прогонщик записанных потоков без ключа API.
 * Новый сценарий из живой партии: секция `## trace` дампа → `eventsFromDebugDump`,
 * перед пачкой — шаг `tool` / `speech` / `interrupt` (в дампе это строки `out`).
 * Как именно — docs/DEBUG.md, раздел «Поток из дампа».
 * Grok шлёт ту же форму, что OpenAI: отдельного провода здесь нет.
 * Счёт партии этот файл не проверяет, кроме границы кнопки в конце файла. «Строго последняя разборчивая» — answerTurn.test.ts.
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

  it('Gemini: голый done без created не применяется; created провода без метки хода — применяется', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    play([
      { kind: 'tool', purpose: 'select', turn: 5, name: 'selectQuestion', instructions: 'выбери' },
      { kind: 'in', wire: 'gemini', events: [{ type: 'response.done', response: { id: 'gem-bare', status: 'completed', output: [selectCall('selectQuestion')] } }] },
    ])
    expect(toolCalls).toEqual([])
    expect(notesSince(cursor).some((title) => title.includes('без метки хода'))).toBe(true)
    // geminiWire после response.create сам шлёт response.created со своим id и без metadata.
    play([
      { kind: 'in', wire: 'gemini', events: [
        { type: 'response.created', response: { id: 'gem-1', status: 'in_progress', output: [] } },
        { type: 'response.done', response: { id: 'gem-1', status: 'completed', output: [selectCall('selectQuestion')] } },
      ] },
    ])
    expect(toolCalls).toEqual([{ purpose: 'select', turn: 5, name: 'selectQuestion' }])
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

describe('история чтения и оценки', () => {
  const cell = 'Сколько струн у скрипки?'
  const etalon = 'Эталон пакета: четыре струны.'

  function typeOf(event: object): string {
    return 'type' in event && typeof event.type === 'string' ? event.type : ''
  }

  it('Qwen: вопрос и эталон только в инструкции сессии, выключение флага возвращает item', () => {
    const read = {
      type: 'response.create',
      response: {
        metadata: { purpose: 'read', turn: '1' },
        instructions: 'Зачитай вопрос',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: cell }] }],
      },
    }
    const on = qwenTranslateOutbound(read)
    expect(on.events.some((event) => typeOf(event) === 'conversation.item.create')).toBe(false)
    expect(JSON.stringify(on.events)).toContain(cell)
    const off = qwenTranslateOutbound(read, { isolateHistory: false })
    expect(off.events.some((event) => typeOf(event) === 'conversation.item.create')).toBe(true)
    const judge = {
      type: 'response.create',
      response: {
        metadata: { purpose: 'judge', turn: '2' },
        output_modalities: ['text'],
        tool_choice: { type: 'function', name: 'submitAnswerJudgment' },
        instructions: etalon,
      },
    }
    const judged = qwenTranslateOutbound(judge)
    expect(judged.events.some((event) => typeOf(event) === 'conversation.item.create')).toBe(false)
    expect(JSON.stringify(judged.events)).toContain(etalon)
  })

  it('Gemini: вопрос в systemInstruction, в историю — команда без вопроса; следующий ход инструкцию возвращает', () => {
    const read = {
      type: 'response.create',
      response: {
        metadata: { purpose: 'read', turn: '1' },
        instructions: 'Зачитай',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: cell }] }],
      },
    }
    const plan = geminiOutboundTurns(read, { isolateHistory: true, historyIsolated: false })
    expect(plan.isolated).toBe(true)
    expect(JSON.stringify(plan.messages[0])).toContain(cell)
    expect(JSON.stringify(plan.messages[1])).not.toContain(cell)
    expect(JSON.stringify(plan.messages[1])).toContain('Зачитай игрокам')
    const next = geminiOutboundTurns({
      type: 'response.create',
      response: { metadata: { purpose: 'announce', turn: '2' }, instructions: 'Верно, Вася' },
    }, { isolateHistory: true, historyIsolated: true })
    expect(next.isolated).toBe(false)
    expect(JSON.stringify(next.messages[0])).toContain('contextUpdate')
    expect(JSON.stringify(next.messages[0])).not.toContain(cell)
    const kept = geminiOutboundTurns(read, { isolateHistory: false, historyIsolated: false })
    expect(kept.isolated).toBe(false)
    expect(JSON.stringify(kept.messages)).toContain(cell)
    expect(kept.messages.some((message) => 'contextUpdate' in message)).toBe(false)
  })
})

function cell(id: string, themeId: string, themeName: string, value: number): Question {
  return { id, roundIndex: 0, themeId, themeName, value, text: 'Вопрос', answers: ['ответ'] }
}

const boundaryPack: QuestionPack = {
  name: 'Граница',
  rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
  warnings: [],
  questions: [cell('p-400', 'p', 'П......Ц', 400)],
}

async function bootBoundary(client: MockRealtimeClient) {
  vi.stubGlobal('window', {
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  })
  const actor = createActor(gameMachine)
  actor.start()
  const stop = attachController({
    actor,
    client,
    getApiKey: () => 'test-key',
    setLink: () => {},
  })
  actor.send({ type: 'START_GAME', pack: boundaryPack })
  await vi.advanceTimersByTimeAsync(80)
  actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
  await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
  return { actor, stop }
}

function scoreOf(actor: ReturnType<typeof createActor<typeof gameMachine>>, playerId: number): number {
  return actor.getSnapshot().context.players.find((player) => player.id === playerId)?.score ?? 0
}

function playerMark(text: string): string | undefined {
  const line = getTrace().find((entry) => {
    const detail = entry.detail as { text?: string } | undefined
    return entry.kind === 'chat' && detail?.text === text
  })
  return (line?.detail as { mark?: { kind?: string } } | undefined)?.mark?.kind
}

describe('граница кнопки', () => {
  it('до-кнопочная речь уходит только в чат и не оценивается', async () => {
    const client = new MockRealtimeClient()
    const speech = vi.spyOn(client, 'requestSpeech')
    const { actor, stop } = await bootBoundary(client)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    client.onSpeechStarted({ itemId: 'pre' })
    client.deliverTranscript('pre', 'мимо темы')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(client.buttonCuts).toEqual(['commit'])
    expect(scoreOf(actor, 1)).toBe(0)
    expect(playerMark('мимо темы')).toBe('beforeButton')
    const cue = String(speech.mock.calls.find((call) => call[0] === 'buzzCall')?.[2] ?? '')
    expect(cue).toContain('мимо темы')
    expect(cue).toContain('ДО кнопки')
    expect(cue).toContain('вслух не повторяй')
    stop()
    actor.stop()
  })

  it('речь, начатая до кнопки и продолженная после, в ответ берёт только хвост', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await bootBoundary(client)
    client.onSpeechStarted({ itemId: 'head' })
    client.deliverTranscript('head', 'мимо темы')
    client.continueAfterCut = 'tail'
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(client.buttonCuts).toEqual(['commit'])
    expect(scoreOf(actor, 1)).toBe(0)
    client.deliverTranscript('tail', 'ответ')
    client.emitSpeechStopped('tail', 800)
    await vi.advanceTimersByTimeAsync(120 + answerSilenceDecideMs)
    expect(playerMark('мимо темы')).toBe('beforeButton')
    expect(scoreOf(actor, 1)).toBe(400)
    stop()
    actor.stop()
  })

  it('комментарий не звучит, если игрок уже говорит', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await bootBoundary(client)
    await vi.advanceTimersByTimeAsync(500)
    client.onSpeechStarted({ itemId: 'blurt' })
    client.deliverTranscript('blurt', 'уже говорили вслух')
    client.emitSpeechStopped('blurt', 400)
    await vi.advanceTimersByTimeAsync(80)
    expect(playerMark('уже говорили вслух')).toBe('beforeButton')
    const speech = vi.spyOn(client, 'requestSpeech')
    client.continueAfterCut = 'tail'
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    await vi.advanceTimersByTimeAsync(80)
    const cues = speech.mock.calls.filter((call) => call[0] === 'buzzCall').map((call) => String(call[2]))
    expect(cues.some((cue) => cue.includes('уже говорили вслух'))).toBe(false)
    expect(scoreOf(actor, 1)).toBe(0)
    stop()
    actor.stop()
  })
})

const gluedPhrase = 'Текст 100. Давай, слушай, чё ты мне этот, голову-то морочишь?'
const gluedAnswer = `${gluedPhrase} Цицерон.`

/** Кусок дампа 25 октября: выбор закрылся фразой, ответ — та же фраза плюс «Цицерон». */
const grokGlueDump = `## trace

2026-10-25T07:09:24.538Z in conversation.item.input_audio_transcription.completed
{"type":"conversation.item.input_audio_transcription.completed","item_id":"137dec2f","transcript":"${gluedPhrase}","status":"completed"}

2026-10-25T07:09:36.029Z in conversation.item.input_audio_transcription.completed
{"type":"conversation.item.input_audio_transcription.completed","item_id":"6f55ce40","transcript":"${gluedAnswer}","status":"completed"}
`

/** Кусок дампа: несколько completed одной реплики выбора, годный текст — не первый. */
const grokGrowingDump = `## trace

2026-10-25T07:09:08.116Z in input_audio_buffer.speech_started
{"type":"input_audio_buffer.speech_started","item_id":"d2d910e6","audio_start_ms":31928}

2026-10-25T07:09:08.364Z in conversation.item.input_audio_transcription.completed
{"type":"conversation.item.input_audio_transcription.completed","item_id":"d2d910e6","transcript":"Text","status":"in_progress"}

2026-10-25T07:09:09.234Z in input_audio_buffer.speech_stopped
{"type":"input_audio_buffer.speech_stopped","item_id":"d2d910e6","audio_end_ms":33041}

2026-10-25T07:09:09.263Z in conversation.item.input_audio_transcription.completed
{"type":"conversation.item.input_audio_transcription.completed","item_id":"d2d910e6","transcript":"Текст 100.","status":"in_progress"}

2026-10-25T07:09:09.803Z in conversation.item.input_audio_transcription.completed
{"type":"conversation.item.input_audio_transcription.completed","item_id":"d2d910e6","transcript":"Текст 100.","status":"completed"}

2026-10-25T07:09:10.100Z in conversation.item.input_audio_transcription.completed
{"type":"conversation.item.input_audio_transcription.completed","item_id":"d2d910e6","transcript":"Текст 100. лишнее","status":"completed"}
`

function grokClientEvents(dump: string): object[] {
  let turn = freshGrokTurn()
  const out: object[] = []
  for (const event of eventsFromDebugDump(dump)) {
    const parsed = grokInbound(event, turn)
    turn = parsed.turn
    out.push(...parsed.events)
  }
  return out
}

describe('Grok: подклеенная фраза и нарастающая расшифровка', () => {
  it('OpenAI оставляет первую completed и не подменяет её следующей', () => {
    play([
      { kind: 'in', events: [
        { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Text' },
        { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Текст 100.' },
      ] },
    ])
    expect(transcripts).toEqual([{ itemId: 'a', text: 'Text' }])
  })

  it('нарастающие completed выбора берутся как «Текст 100.», поздняя правка ход не открывает', () => {
    const events = grokClientEvents(grokGrowingDump)
    const completed = events.filter((event) => (event as { type?: string }).type === 'conversation.item.input_audio_transcription.completed')
    expect(completed).toEqual([
      expect.objectContaining({ item_id: 'd2d910e6', transcript: 'Текст 100.', status: 'completed' }),
    ])
    for (const event of events) feed(event)
    expect(transcripts).toEqual([{ itemId: 'd2d910e6', text: 'Текст 100.' }])
  })

  it('префикс фразы до кнопки не уходит в оценку, хвост «Цицерон» уходит, техническая строка есть', async () => {
    const fromDump = eventsFromDebugDump(grokGlueDump).map((event) => (event as { transcript?: string }).transcript)
    expect(fromDump).toEqual([gluedPhrase, gluedAnswer])
    const pack: QuestionPack = {
      name: 'Текст',
      rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
      warnings: [],
      questions: [{
        id: 't-100',
        roundIndex: 0,
        themeId: 't',
        themeName: 'Т....Т',
        value: 100,
        text: 'Кто это?',
        answers: ['Цицерон'],
      }],
    }
    const voice = new MockRealtimeClient()
    const actor = createActor(gameMachine)
    actor.start()
    const stop = attachController({ actor, client: voice, getApiKey: () => 'test-key', setLink: () => {} })
    actor.send({ type: 'START_GAME', pack })
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    voice.hear(gluedPhrase, 2600)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 100)
    if (statePath(actor.getSnapshot().value).startsWith('reading')) {
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
      await vi.advanceTimersByTimeAsync(80)
    }
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    await vi.advanceTimersByTimeAsync(40)
    voice.hear(gluedAnswer, 1022)
    await vi.advanceTimersByTimeAsync(120 + answerSilenceDecideMs)
    const system = getTrace().filter((entry) => entry.kind === 'chat' && entry.title === 'Техническое')
      .map((entry) => (entry.detail as { text?: string }).text ?? '')
    expect(system.some((line) => line.includes('распознаватель подклеил фразу до кнопки') && line.includes(gluedPhrase) && line.includes('Цицерон'))).toBe(true)
    const judged = getTrace().filter((entry) => entry.kind === 'note' && entry.title.includes('засчитываю без модели'))
    expect(judged.some((entry) => entry.title.includes('Цицерон') && !entry.title.includes(gluedPhrase))).toBe(true)
    expect(scoreOf(actor, 1)).toBe(100)
    const prefixLine = getTrace().find((entry) => {
      const detail = entry.detail as { text?: string; mark?: { kind?: string } } | undefined
      return entry.kind === 'chat' && detail?.mark?.kind === 'beforeButton' && detail.text === gluedPhrase
    })
    expect(prefixLine).toBeTruthy()
    stop()
    actor.stop()
  })
})

/** Дамп 25 октября, «Э, квадрат»: ошибка отмены чужого id пришла раньше вердикта. */
const squareJudgeDump = `## trace

2026-10-25T07:53:29.678Z in response.done
{"type":"response.done","response":{"id":"397ea7af-279c-4182-b6a9-d153454b84e0","output":[{"type":"function_call","name":"submitAnswerJudgment","call_id":"call-square-foreign","arguments":"{\\"status\\":\\"unintelligible\\",\\"heard\\":\\"Э, квадрат.\\",\\"reason\\":\\"чужой вызов\\",\\"speech\\":\\"answer\\",\\"guessing\\":false}"}]}}

2026-10-25T07:53:29.774Z in error
{"type":"error","error":{"message":"Response ID '8c8fffb6-4b49-4ae9-9909-c74d459bac21' does not match current response","type":"invalid_request_error","code":"invalid_request_error","event_id":"5abf5b5d-a8a4-4e2c-bfec-1440df1c447a"}}

2026-10-25T07:53:29.926Z in response.created
{"type":"response.created","response":{"id":"d1daaa3c-12ad-45b4-aa25-3dda055151b8","status":"in_progress","metadata":{"purpose":"judge","turn":"22"}}}

2026-10-25T07:53:30.434Z in response.done
{"type":"response.done","response":{"id":"d1daaa3c-12ad-45b4-aa25-3dda055151b8","status":"completed","metadata":{"purpose":"judge","turn":"22"},"output":[{"type":"function_call","name":"submitAnswerJudgment","call_id":"call-square","arguments":"{\\"status\\":\\"correct\\",\\"heard\\":\\"Э, квадрат.\\",\\"reason\\":\\"Квадрат совпадает с эталоном\\",\\"speech\\":\\"answer\\",\\"guessing\\":false}"}]}}
`

/** Дамп 25 октября, пауза после «три»: спонтанный вызов и объявление без response.created. */
const pauseAfterThreeDump = `## trace

2026-10-25T07:51:50.063Z in response.done
{"type":"response.done","response":{"id":"2db7974e-12ad-45b4-aa25-3dda055151b8","output":[{"type":"function_call","name":"submitAnswerJudgment","call_id":"call-15943ad0-04b1-4a0d-8e1b-728435c95006-12","arguments":"{\\"status\\":\\"unintelligible\\",\\"heard\\":\\"Три\\",\\"reason\\":\\"Одно слово без контекста\\",\\"speech\\":\\"answer\\",\\"guessing\\":false}"}]}}

2026-10-25T07:51:52.163Z in error
{"type":"error","error":{"message":"Response ID '8c8fffb6-4b49-4ae9-9909-c74d459bac21' does not match current response","type":"invalid_request_error","code":"invalid_request_error"}}
`

function useGrokAckWire(): void {
  const opened = client as unknown as Harness & {
    wire: { acksForeignToolCalls: boolean; restartsSilentSpeech: boolean; send(event: object): boolean; close(): void }
  }
  opened.wire = {
    acksForeignToolCalls: true,
    restartsSilentSpeech: true,
    send(event: object) {
      sent.push(event as Record<string, unknown>)
      return true
    },
    close() {},
  }
}

/** Дамп 25 октября, загадки: вердикт без звука — повторный submitAnswerJudgment на реплике объявления. */
const riddlesAnnounceDump = `## trace

2026-10-25T08:43:46.046Z in response.done
{"type":"response.done","response":{"id":"ca3a3d23-bd25-47ee-8295-e2902f5de55b","status":"completed","metadata":{"purpose":"judge","turn":"2"},"output":[{"type":"function_call","name":"submitAnswerJudgment","call_id":"call-f65d0100-475d-4dff-bef9-518dbb663f36-1","arguments":"{\\"status\\":\\"correct\\",\\"heard\\":\\"А, я знаю, что это буква Р. Это буква Р.\\",\\"speech\\":\\"answer\\",\\"guessing\\":false}"}]}}

2026-10-25T08:43:47.607Z in response.created
{"type":"response.created","response":{"id":"2030301a-eaa5-4545-98f8-68e0209428f8","status":"in_progress","metadata":{"purpose":"announce","turn":"9"}}}

2026-10-25T08:43:48.331Z in response.done
{"type":"response.done","response":{"id":"2030301a-eaa5-4545-98f8-68e0209428f8","output":[{"type":"function_call","name":"submitAnswerJudgment","call_id":"call-5a478dd6-e252-43d0-a8f6-deac7602f63e-1","arguments":"{\\"status\\":\\"correct\\",\\"heard\\":\\"А, я знаю, что это буква Р. Это буква Р.\\",\\"speech\\":\\"answer\\",\\"guessing\\":false}"}]}}
`

/** Дамп 25 октября, загадки: чтение вопроса открылось и 7 с не дало звука. */
const riddlesReadDump = `## trace

2026-10-25T08:43:34.106Z in response.created
{"type":"response.created","response":{"id":"5744c8c5-ce52-4618-951a-fca64b666a13","status":"in_progress","metadata":{"purpose":"read","turn":"6"}}}
`

const riddleQuestion = 'Что в России на первом месте, а во Франции на втором?'

describe('дамп 25 октября: квадрат и пауза после «три»', () => {
  it('ошибка чужой отмены не подменяет вердикт «Э, квадрат»; OpenAI чужой вызов не закрывает', () => {
    const calls: Array<{ name: string | null; args: unknown }> = []
    client.onToolCall = (call) => calls.push({ name: call?.name ?? null, args: call?.arguments ?? null })
    feed({ type: 'response.created', response: { id: '8c8fffb6-4b49-4ae9-9909-c74d459bac21', status: 'in_progress' } })
    client.requestTool('judge', 22, 'submitAnswerJudgment', 'Оцени реплику «Э, квадрат.»')
    play([{ kind: 'in', events: eventsFromDebugDump(squareJudgeDump) }])
    expect(calls.map((call) => call.name)).toEqual(['submitAnswerJudgment'])
    expect(JSON.stringify(calls[0]?.args)).toContain('Э, квадрат.')
    expect(JSON.stringify(calls[0]?.args)).toContain('correct')
    expect(sent.some((event) => event.type === 'conversation.item.create')).toBe(false)
  })

  it('Grok закрывает чужой submitAnswerJudgment, вердикт «Э, квадрат» всё равно доходит', () => {
    useGrokAckWire()
    const calls: Array<{ name: string | null; args: unknown }> = []
    client.onToolCall = (call) => calls.push({ name: call?.name ?? null, args: call?.arguments ?? null })
    feed({ type: 'response.created', response: { id: '8c8fffb6-4b49-4ae9-9909-c74d459bac21', status: 'in_progress' } })
    client.requestTool('judge', 22, 'submitAnswerJudgment', 'Оцени реплику «Э, квадрат.»')
    play([{ kind: 'in', events: eventsFromDebugDump(squareJudgeDump) }])
    expect(calls.map((call) => call.name)).toEqual(['submitAnswerJudgment'])
    expect(JSON.stringify(calls[0]?.args)).toContain('correct')
    const outputs = sent.filter((event) => event.type === 'conversation.item.create')
    expect(outputs).toHaveLength(1)
    expect(JSON.stringify(outputs[0])).toContain('call-square-foreign')
    expect(JSON.stringify(outputs[0])).not.toContain('call-square"')
  })

  it('объявление без response.created заканчивается за 8 с, Grok перед этим закрывает вызов «Три»', () => {
    useGrokAckWire()
    play([{ kind: 'in', events: eventsFromDebugDump(pauseAfterThreeDump) }])
    expect(sent.some((event) => JSON.stringify(event).includes('call-15943ad0'))).toBe(true)
    client.requestSpeech('announce', 10, 'Скажи, что верно, и плюс 100.')
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs - 1)
    expect(finished).toEqual([])
    vi.advanceTimersByTime(1)
    expect(finished).toEqual(['announce'])
  })
})

describe('дамп 25 октября, загадки: выбор слышен, ведущая молчит', () => {
  it('Grok закрывает принятый вердикт и повторяет объявление, которое пришло вызовом функции', () => {
    useGrokAckWire()
    client.onToolCall = (call) => {
      if (call) client.sendToolOutput(call.callId, { accepted: true, status: 'correct' })
    }
    client.requestTool('judge', 2, 'submitAnswerJudgment', 'Оцени реплику', true)
    const judge = eventsFromDebugDump(riddlesAnnounceDump)[0]
    expect(judge).toBeTruthy()
    feed({ type: 'response.created', response: { id: 'ca3a3d23-bd25-47ee-8295-e2902f5de55b', status: 'in_progress', metadata: { purpose: 'judge', turn: '2' } } })
    if (judge) feed(judge)
    const accepted = sent.filter((event) => event.type === 'conversation.item.create' && JSON.stringify(event).includes('call-f65d0100'))
    expect(accepted).toHaveLength(1)
    expect(JSON.stringify(accepted[0])).toContain('accepted\\":true')
    client.requestSpeech('announce', 9, 'Скажи, что верно, Rogin, плюс 100.', undefined, true)
    for (const event of eventsFromDebugDump(riddlesAnnounceDump).slice(1)) feed(event)
    const foreign = sent.filter((event) => event.type === 'conversation.item.create' && JSON.stringify(event).includes('call-5a478dd6'))
    expect(foreign).toHaveLength(1)
    expect(JSON.stringify(foreign[0])).toContain('Вызов не относится к текущему ходу')
    const announces = sent.filter((event) => event.type === 'response.create' && JSON.stringify(event).includes('"purpose":"announce"'))
    expect(announces.length).toBeGreaterThanOrEqual(2)
    expect(finished).toEqual([])
    feed({ type: 'response.created', response: { id: 'retry-announce', status: 'in_progress', metadata: { purpose: 'announce', turn: '9' } } })
    feed({ type: 'output_audio_buffer.started', response_id: 'retry-announce' })
    feed({
      type: 'response.done',
      response: {
        id: 'retry-announce',
        status: 'completed',
        metadata: { purpose: 'announce', turn: '9' },
        output: [{ type: 'message', content: [{ type: 'audio', transcript: 'Верно, Rogin, плюс 100.' }] }],
      },
    })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'retry-announce' })
    expect(finished).toEqual(['announce'])
  })

  it('OpenAI принятый isolated-вердикт function_call_output не шлёт и молчаливое чтение не повторяет', () => {
    client.onToolCall = (call) => {
      if (call) client.sendToolOutput(call.callId, { accepted: true, status: 'correct' })
    }
    client.requestTool('judge', 2, 'submitAnswerJudgment', 'Оцени реплику', true)
    feed({ type: 'response.created', response: { id: 'ca3a3d23-bd25-47ee-8295-e2902f5de55b', status: 'in_progress', metadata: { purpose: 'judge', turn: '2' } } })
    const judge = eventsFromDebugDump(riddlesAnnounceDump)[0]
    if (judge) feed(judge)
    expect(sent.some((event) => event.type === 'conversation.item.create')).toBe(false)
    client.requestSpeech('read', 6, 'зачитай', riddleQuestion)
    const before = sent.filter((event) => event.type === 'response.create').length
    for (const event of eventsFromDebugDump(riddlesReadDump)) feed(event)
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs)
    expect(sent.filter((event) => event.type === 'response.create').length).toBe(before)
    expect(finished).toEqual([])
  })

  it('Grok повторяет чтение, если ответ открылся и звук не начался', () => {
    useGrokAckWire()
    client.requestSpeech('read', 6, 'зачитай', riddleQuestion)
    for (const event of eventsFromDebugDump(riddlesReadDump)) feed(event)
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs - 1)
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(1)
    expect(finished).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(2)
    expect(sent.some((event) => event.type === 'response.cancel' && JSON.stringify(event).includes('5744c8c5'))).toBe(true)
    expect(finished).toEqual([])
    feed({ type: 'response.created', response: { id: 'retry-read', status: 'in_progress', metadata: { purpose: 'read', turn: '6' } } })
    feed({ type: 'output_audio_buffer.started', response_id: 'retry-read' })
    feed({
      type: 'response.done',
      response: {
        id: 'retry-read',
        status: 'completed',
        metadata: { purpose: 'read', turn: '6' },
        output: [{ type: 'message', content: [{ type: 'audio', transcript: riddleQuestion }] }],
      },
    })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'retry-read' })
    expect(finished).toEqual(['read'])
  })
})
