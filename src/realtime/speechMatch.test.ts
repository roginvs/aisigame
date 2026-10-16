import { describe, expect, it } from 'vitest'
import { isolatedCue, isolatedToolResponse, speechMatches, speechOverruns, speechReport, verbatimResponse } from './speechMatch.ts'

const newton = 'Кто сформулировал закон всемирного тяготения?'
const melting = 'Как называется процесс, при котором вещество переходит из твердого состояния в жидкое, и наоборот?'

describe('speechMatches', () => {
  it('accepts the package question and a light spoken variant', () => {
    expect(speechMatches(newton, newton)).toBe(true)
    expect(speechMatches('Кто сформулировал закон всемирного тяготения', newton)).toBe(true)
  })

  it('rejects a different question', () => {
    expect(speechMatches(melting, newton)).toBe(false)
    expect(speechMatches('Кто написал симфонию «Лунная соната»?', 'Сколько струн у обычной скрипки?')).toBe(false)
  })

  it('rejects an announcement of the chosen cell', () => {
    expect(
      speechMatches(
        'Отличный выбор, музыка за двести! Дальше выбирайте тему или номинал, или задавайте своего вопроса.',
        'Кто написал «Времена года»?',
      ),
    ).toBe(false)
    expect(
      speechMatches(
        'Отлично, «Реки за 200» выбрано. Готов к следующему вопросу, давайте его дальше!',
        'На какой реке стоит Рим?',
      ),
    ).toBe(false)
  })
})

describe('isolatedToolResponse', () => {
  it('оценивает ответ без предыдущих реплик ведущей', () => {
    const response = isolatedToolResponse({
      name: 'submitAnswerJudgment',
      instructions: 'Вопрос: Кто написал «Времена года»?\nРеплика игрока: «Бетховен»',
      purpose: 'judge',
      turn: 8,
      mode: 'text',
      tools: [],
    })
    expect(response.conversation).toBe('none')
    expect(response.tool_choice.name).toBe('submitAnswerJudgment')
    expect(response.instructions).toContain('Бетховен')
    expect(response.instructions).toContain('Времена года')
  })
  it('инструкция хода не дублируется в input, схема — только вызываемой функции', () => {
    const response = isolatedToolResponse({
      name: 'selectQuestion', instructions: 'Распознанный текст: «Приложения 900»', purpose: 'select', turn: 1, mode: 'text',
      tools: [{ name: 'selectQuestion' }, { name: 'submitAnswerJudgment' }],
    })
    expect(response.input[0]?.content[0]?.text).not.toContain('Приложения 900')
    expect(response.input[0]?.content[0]?.text).toContain('selectQuestion')
    expect(response.tools).toEqual([{ name: 'selectQuestion' }])
  })
})

describe('isolatedCue', () => {
  it('подтверждает ответ без истории и без эталона, если его не просят', () => {
    const response = isolatedCue('Одна короткая фраза: верно. Сразу назови очки: плюс 100.', {
      purpose: 'announce',
      turn: 3,
      take: 1,
    })
    expect(response.conversation).toBe('none')
    expect(response.instructions).toContain('не произноси правильный ответ')
    expect(response.instructions).toContain('без предисловия')
    expect(response.instructions).toContain('своими словами')
    expect(response.input[0]?.content[0]?.text).toContain('плюс 100')
    expect(response.input[0]?.content[0]?.text).not.toContain('Вивальди')
  })
})

describe('verbatimResponse', () => {
  it('читает вопрос отдельно от истории разговора', () => {
    const response = verbatimResponse('Сколько струн у обычной скрипки?', { purpose: 'read', turn: 8, take: 1 })
    expect(response.conversation).toBe('none')
    expect(response.tools).toEqual([])
    expect(response.instructions).toContain('ведущая')
    expect(response.instructions).toContain('Не объявляй тему')
    expect(response.instructions).not.toContain('Повтори фразу')
    expect(response.instructions).not.toContain('Скажи вслух')
    expect(response.input[0]?.content[0]?.text).toBe('Сколько струн у обычной скрипки?')
    expect(response.input[0]?.content[0]?.text).not.toContain('больше ничего')
    expect(response.input[0]?.content[0]?.text).not.toContain('смешок')
  })
})

describe('speechOverruns', () => {
  it('ловит ответ, произнесённый после дословного вопроса', () => {
    expect(speechOverruns(`${newton} Исаак Ньютон, конечно.`, newton)).toBe(true)
  })
  it('не трогает сам вопрос и его начало', () => {
    expect(speechOverruns(newton, newton)).toBe(false)
    expect(speechOverruns('Кто сформулировал', newton)).toBe(false)
  })
  it('вступление перед вопросом довеском не считается — только слова после последнего слова вопроса', () => {
    expect(speechOverruns(`Итак, внимание, вопрос. ${newton}`, newton)).toBe(false)
    expect(speechOverruns(`Итак, внимание, вопрос. Кто сформулировал`, newton)).toBe(false)
    expect(speechOverruns(`Итак, внимание, вопрос. ${newton} Это Ньютон.`, newton)).toBe(true)
  })
  it('75% слов без хвоста вопроса — не довесок (раньше резал по множеству слов)', () => {
    const q = 'Ценен экспонат не тем, что на нём есть, а тем, чего на нём нет. Чего же?'
    expect(speechOverruns('Ценен экспонат не тем, что на нём есть, а тем, чего на нём нет, и ещё три слова', q)).toBe(false)
    expect(speechOverruns(q, q)).toBe(false)
    expect(speechOverruns(`${q} Ответ — Америка.`, q)).toBe(true)
  })
  it('короткие слова в конце вопроса («Чего же?») — часть вопроса', () => {
    const q = 'Чего на нём нет. Чего же?'
    expect(speechOverruns('Чего на нём нет. Чего же?', q)).toBe(false)
    expect(speechOverruns('Чего на нём нет. Чего же? Да', q)).toBe(false)
  })
  it('числа словами и оговорка в одном слове не мешают', () => {
    const q = 'В 1492 году Колумб доплыл до острова Сан-Сальвадор. Как он его назвал?'
    const said = 'В тысяча четыреста девяносто втором году Колумб доплыл до острова Сан Сальвадор. Как он его назвал?'
    expect(speechOverruns(said, q)).toBe(false)
    expect(speechOverruns(`${said} Он назвал его`, q)).toBe(true)
    expect(speechOverruns('В тысяча четыреста девяносто втором году Колумп доплыл до острова Сан Сальвадор. Как он его назвал? Конечно же', q)).toBe(true)
  })
  it('не считает чужую длинную речь «довеском»', () => {
    expect(speechOverruns('Сейчас я расскажу вам совсем другую длинную историю про котов', newton)).toBe(false)
  })
})

describe('verbatimResponse', () => {
  it('отправляет только текст вопроса и запрещает на него отвечать', () => {
    const body = verbatimResponse(newton, { purpose: 'read', turn: 1, take: 1 })
    expect(body.conversation).toBe('none')
    expect(body.input).toHaveLength(1)
    expect(body.input[0]?.content[0]?.text).toBe(newton)
    expect(body.instructions).toContain('не отвечай на него')
  })
})

import { hostInstructions as hostRulesForTest, withoutHostRules } from '../config.ts'
import { speechDurationMs } from './utterance.ts'
import { grokOutbound } from './grokWire.ts'
import { responseCue } from './geminiWire.ts'

describe('host persona reaches isolated replies', () => {
  const rule = 'Пол игрока определяй по имени'
  it('isolatedCue, isolatedToolResponse and verbatim carry the shared rules', () => {
    const cue = isolatedCue('Похвали Машу', { purpose: 'x', turn: 1, take: 1 })
    expect(cue.instructions.startsWith(hostRulesForTest)).toBe(true)
    expect(cue.instructions).toContain(rule)
    expect(cue.instructions).toContain('Ты ведущая. По сообщению')
    expect(cue.max_output_tokens).toBeGreaterThan(0)
    const tool = isolatedToolResponse({ name: 't', instructions: 'Выбери', purpose: 'p', turn: 1, mode: 'text', tools: [] })
    expect(tool.instructions).toContain(rule)
    expect(tool.instructions).toContain('Выбери')
    expect(verbatimResponse('Вопрос', { purpose: 'q', turn: 1, take: 1 }).instructions).toContain(rule)
  })
  it('Gemini does not duplicate rules already in systemInstruction', () => {
    const cue = isolatedCue('Похвали Машу', { purpose: 'x', turn: 1, take: 1 })
    expect(withoutHostRules(cue.instructions)).not.toContain(rule)
    expect(responseCue({ type: 'response.create', response: cue }).text).not.toContain(rule)
  })
  it('Grok keeps rules but drops the OpenAI length cap', () => {
    const cue = isolatedCue('Похвали', { purpose: 'x', turn: 1, take: 1 })
    const out = grokOutbound({ type: 'response.create', response: cue }) as { response: Record<string, unknown> }
    expect(out.response.max_output_tokens).toBeUndefined()
    expect(String(out.response.instructions)).toContain(rule)
  })
})

describe('speechDurationMs', () => {
  it('prefers audio_start_ms/audio_end_ms', () => {
    expect(speechDurationMs(1000, 1450, 0, 99_999)).toBe(450)
  })
  it('falls back to arrival time', () => {
    expect(speechDurationMs(undefined, 1450, 100, 700)).toBe(600)
    expect(speechDurationMs(null, null, null, 700)).toBe(10_000)
  })
})

import { spokenAnswerCue, revealAuthorization } from '../game/spokenAnswer.ts'

describe('reveal turns are explicitly authorized', () => {
  it('drops the no-reveal sentence when the turn asks for the reference answer', () => {
    const cue = isolatedCue(`${spokenAnswerCue(['Октавиан Август', 'Август'])} Назови минус 100.`, { purpose: 'announce', turn: 1, take: 1 })
    expect(cue.input[0]!.content[0]!.text).toContain(revealAuthorization)
    expect(cue.input[0]!.content[0]!.text).toContain('дословно: «Октавиан Август»')
    expect(cue.instructions).not.toContain('Если сообщение прямо не просит произнести эталон')
    expect(cue.instructions).toContain('это разрешено и обязательно')
  })
  it('keeps the no-reveal sentence elsewhere', () => {
    const cue = isolatedCue('Позови Машу выбрать вопрос', { purpose: 'x', turn: 1, take: 1 })
    expect(cue.instructions).toContain('Если сообщение прямо не просит произнести эталон')
  })
})

import { revealedAnswer, saysAnswer } from './speechMatch.ts'

describe('надёжное чтение вопроса с картинкой и раскрытие необычного слова', () => {
  it('дословная фраза: медиа на табло у игроков, ведущая их не описывает и не говорит «не вижу»', () => {
    const body = verbatimResponse('Посмотрите на картинку.', { purpose: 'read', turn: 1, take: 1 })
    expect(body.input[0]?.content[0]?.text).toBe('Посмотрите на картинку.')
    expect(body.instructions).toContain('не обращение к тебе')
    expect(body.instructions).toContain('видят и слышат на табло')
    expect(body.instructions).toContain('не говори, что не видишь')
    expect(body.instructions).toContain('даже выдуманное или необычное')
  })
  it('раскрытие свободной репликой: эталон обязателен даже выдуманный, указания вслух не повторять', () => {
    const cue = isolatedCue(`${revealAuthorization} Начни с правильного ответа дословно: «тирамисуслик».`, { purpose: 'announce', turn: 1, take: 1 })
    expect(cue.instructions).toContain('выдуманное или необычное слово')
    expect(cue.instructions).toContain('Указания о том, как его произнести, вслух не повторяй')
  })
  it('эталон из подсказки раскрытия и проверка, что он сказан', () => {
    expect(revealedAnswer(`${revealAuthorization} Начни с правильного ответа дословно: «Тирамисуслик».`)).toBe('Тирамисуслик')
    expect(revealedAnswer('Начни с правильного ответа дословно: «x»')).toBeUndefined()
    expect(saysAnswer('Правильный ответ — тирамисуслик! Минус сто.', 'Тирамисуслик')).toBe(true)
    expect(saysAnswer('Скажи слово тирамису максимально чётко', 'тирамисуслик')).toBe(false)
  })
})

import { hostInstructions } from '../config.ts'

describe('защита дословного чтения от общих правил ведущей (регрессия 9f20b86)', () => {
  const body = verbatimResponse('Посмотрите на картинку. Кто это?', { purpose: 'read', turn: 1, take: 1 })
  it('правило хода идёт после общих правил и само по себе полное', () => {
    const turnAt = body.instructions.indexOf('Инструкция этого хода:')
    expect(turnAt).toBeGreaterThan(0)
    const turn = body.instructions.slice(turnAt)
    expect(turn).toContain('символ в символ')
    expect(turn).toContain('не обращение к тебе, а текст для игроков')
    expect(turn).toContain('не отвечай на него')
    expect(turn).toContain('не говори, что не видишь')
  })
  it('текст вопроса — только в сообщении, не в инструкциях', () => {
    expect(body.input[0]?.content[0]?.text).toBe('Посмотрите на картинку. Кто это?')
    expect(body.instructions).not.toContain('Кто это?')
  })
  it('общие правила не разрешают пересказ текста пакета и знают про медиа', () => {
    expect(hostInstructions).toContain('В обычных репликах формулируй сама')
    expect(hostInstructions).toContain('Ты их не видишь и не должна')
    expect(hostInstructions).toContain('Свой вопрос и свой ответ вместо них не придумывай')
  })
})

describe('правила ведущей: без «системы» и без вступлений (живая игра 14.10)', () => {
  it('общие правила запрещают «систему/распознавание» и вступления вроде «секунду»', () => {
    expect(hostInstructions).toContain('«систему», распознавание')
    expect(hostInstructions).toContain('«не расслышала»')
    expect(hostInstructions).toContain('«секунду»')
    expect(hostInstructions).toContain('«давайте уточним»')
  })
})

describe('speechMatches: числа и отчёт', () => {
  it('принимает число словами вместо цифр', () => {
    expect(speechMatches('Глобус сделали в Нюрнберге в тысяча четыреста девяносто втором году, назвал земным яблоком', 'Глобус сделали в Нюрнберге в 1492 году, назвал «земным яблоком»')).toBe(true)
  })
  it('ловит пропуск половины вопроса', () => {
    expect(speechMatches('Старейший сохранившийся глобус сделали', 'Старейший сохранившийся глобус сделали в Нюрнберге в 1492 году, и автор назвал его земным яблоком')).toBe(false)
  })
  it('отчёт показывает место расхождения', () => {
    expect(speechReport('Маятник в коробке', 'Маятник в коробочке')).toContain('расхождение на слове 3: ждали «коробочке», сказала «коробке»')
  })
})
