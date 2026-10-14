import type { QuestionPack } from '../game/types.ts'
import type { GameVoice } from '../realtime/client.ts'
import { formatEta } from './packProgress.ts'
import type { RosterEntry } from './roster.ts'

/** Быстрые вход/сверка/ready собираются в одну реплику, а не перебивают друг друга. */
export const LOBBY_SPEECH_MIN_INTERVAL_MS = 15_000
/** Без смены статусов ведущая реже напоминает, кто в комнате и кого ждём. */
export const LOBBY_IDLE_INTERVAL_MS = 25_000
/** В лобби реплика стартует только после короткой тишины комнаты, чтобы не врезаться в разговор. */
export const LOBBY_SILENCE_BEFORE_SPEECH_MS = 5_000
/** Как часто проверяем тишину, пока ждём окно перед репликой лобби. */
export const LOBBY_SILENCE_POLL_MS = 400

export type LobbySpeechFacts = {
  kind: 'opened' | 'update' | 'idle'
  packName: string
  packSummary: string
  roster: RosterEntry[]
  waitingForMaster?: boolean
  publicContext?: string
}

/** Видимые гости (не мастер): все скачали и нажали «готов». */
export function lobbyEveryoneReady(roster: RosterEntry[]): boolean {
  const guests = roster.filter((entry) => !entry.hidden && !entry.isMaster)
  return guests.length > 0 && guests.every((entry) => entry.hashOk && entry.ready)
}

export function lobbyRosterStatusLine(entry: RosterEntry): string {
  const role = entry.isMaster ? 'мастер' : 'игрок'
  let load: string
  if (entry.hashOk) load = 'пакет сверен'
  else if (entry.percent >= 99) load = 'файл собран, ждёт сверки'
  else {
    const eta = formatEta(entry.etaSeconds)
    load = eta ? `качает, ${entry.percent}%, ещё ${eta}` : `качает, ${entry.percent}%`
  }
  const ready = entry.ready ? ', готов' : entry.hashOk ? ', ещё не нажал «готов»' : ''
  return `- ${entry.name}, ${role}: ${load}${ready}`
}

export function lobbySpeechInstructions(facts: LobbySpeechFacts): string {
  const visible = facts.roster.filter((item) => !item.hidden)
  const everyoneReady = lobbyEveryoneReady(visible)
  const waiting = visible.filter((entry) => !entry.isMaster && !(entry.hashOk && entry.ready))
  const lines: string[] = [
    'Ты обаятельная, чуть кокетливая ведущая в лобби онлайн-игры до старта партии.',
    'Ситуация ниже — контекст, не скрипт: сформулируй реплику сама и по делу.',
    'Не читай проценты загрузки по одному и не называй скорость в КБ/с.',
    'Можно собрать несколько событий в одну фразу, если они пришли подряд.',
    'Ты слышишь недавний разговор игроков: можешь коротко и естественно его прокомментировать, ответить или поддержать беседу.',
    'Не перетягивай разговор на себя: обычно два коротких предложения, для перечня имён можно три.',
    'Статусы состава ниже — источник правды: если игрок говорит, что мастер отключился, а в списке мастер на месте — не подтверждай отключение; скажи, что у тебя он на связи, и коротко перечисли фактический состав.',
  ]

  if (everyoneReady) {
    lines.push(
      'Все гости в комнате скачали пакет и готовы. Скажи, что все готовы и можно начинать.',
      'Сама кнопку «Начать игру» не жми и мастера не поторапливай приказом — только сообщи факт.',
    )
  } else {
    lines.push(
      'Ещё не все готовы: не говори, что можно начинать, и не обещай скорый старт.',
      'Скажи, кто в комнате, кого ещё ждём и что у каждого происходит: качает пакет, сверяет или ещё не нажал «готов».',
      'Если в статусе есть оценка оставшегося времени загрузки, можно коротко её назвать; без оценки время не выдумывай.',
    )
  }

  if (facts.kind === 'idle') {
    lines.push(
      'Статусы не изменились. Если игроки недавно о чём-то говорили, можно коротко подхватить разговор.',
      'Иначе напомни состав: перечисли, кого ещё ждём и что у них: загрузка и сколько осталось, сверка или не нажал «готов».',
      'Не устраивай ажиотаж и не повторяй одну и ту же шутку про ожидание.',
    )
  } else if (facts.kind === 'update') {
    lines.push(
      'Коротко по новому событию, затем при необходимости перечисли, кого всё ещё ждём.',
      'При желании естественно свяжи с недавним разговором.',
    )
  }

  if (facts.kind === 'opened') {
    lines.push(`Игра создана. Пакет: «${facts.packName}». ${facts.packSummary}`)
    lines.push('Цель: дать понять, что комната открыта и ждём игроков по ссылке.')
  }

  lines.push('Состав и статусы:')
  for (const entry of visible) {
    lines.push(lobbyRosterStatusLine(entry))
  }
  if (waiting.length > 0) {
    lines.push(`Ещё ждём: ${waiting.map((entry) => entry.name).join(', ')}.`)
  } else if (everyoneReady) {
    lines.push('Все гости готовы.')
  } else {
    lines.push('Гостей пока нет — ждём игроков по ссылке.')
  }
  if (facts.waitingForMaster) {
    lines.push('Мастер-игрок ещё не в комнате — можно коротко сказать, что ждём его.')
  }
  if (facts.publicContext) lines.push(facts.publicContext)
  return lines.join('\n')
}

let lobbyTurn = 0

export function requestLobbySpeech(client: GameVoice, facts: LobbySpeechFacts): void {
  lobbyTurn += 1
  const instructions = lobbySpeechInstructions(facts)
  client.requestSpeech('lobby', lobbyTurn, instructions, undefined, true)
}

export function packLobbySummary(pack: QuestionPack): string {
  const rounds = pack.rounds.length
  const questions = pack.questions.length
  const final = pack.rounds.some((round) => round.kind === 'final')
  return `Раундов: ${rounds}, вопросов: ${questions}${final ? ', есть финал' : ''}.`
}
