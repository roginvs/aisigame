import type { QuestionPack } from '../game/types.ts'
import { jokeCoin } from '../game/jokeCoin.ts'
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
  publicContext?: string
}

/** Видимые гости (не мастер): все скачали и нажали кнопку готовности. */
export function lobbyEveryoneReady(roster: RosterEntry[]): boolean {
  const guests = roster.filter((entry) => !entry.hidden && !entry.isMaster)
  return guests.length > 0 && guests.every((entry) => entry.hashOk && entry.ready)
}

export function lobbyRosterStatusLine(entry: RosterEntry): string {
  let load: string
  if (entry.hashOk) load = 'пакет сверен'
  else if (entry.percent >= 99) load = 'файл собран, ждёт сверки'
  else {
    const eta = formatEta(entry.etaSeconds)
    load = eta ? `качает, ${entry.percent}%, ещё ${eta}` : `качает, ${entry.percent}%`
  }
  const ready = entry.ready ? ', кнопка нажата' : entry.hashOk ? ', кнопка ещё не нажата' : ''
  return `- ${entry.name}: ${load}${ready}`
}

export function lobbySpeechInstructions(facts: LobbySpeechFacts): string {
  const visible = facts.roster.filter((item) => !item.hidden)
  const everyoneReady = lobbyEveryoneReady(visible)
  const waiting = visible.filter((entry) => !entry.isMaster && !(entry.hashOk && entry.ready))
  const lines: string[] = [
    'Лобби до старта партии. Статусы ниже — источник правды.',
    'Скажи бодро и коротко, одно-два предложения, что видишь и что происходит: кто в комнате, кого ждём и что у них — загрузка с оценкой времени, если она есть, сверка пакета или ещё без кнопки готовности.',
    'Игроков называй только по имени, без ролей; поручений не давай.',
    everyoneReady ? 'Все готовы: скажи, что можно начинать; кнопку сама не жми.' : 'Ещё не все готовы: старт не обещай.',
    'Проценты по одному и скорость загрузки не называй; время без оценки не выдумывай. Можно подхватить недавний разговор.',
    ...(jokeCoin.flip()
      ? ['Настроение: можно добавить одну очень короткую добрую шутку или лёгкое кокетство — своими словами и к месту.']
      : []),
  ]
  if (facts.kind === 'opened') lines.push(`Комната только открыта, ждём игроков по ссылке. Пакет: «${facts.packName}». ${facts.packSummary}`)
  if (facts.kind === 'update') lines.push('Сначала коротко о новом событии.')
  if (facts.kind === 'idle') lines.push('Статусы не изменились: не повторяй прошлую реплику.')
  if (facts.publicContext && /отключ|вылетел|пропал|отвалил|нет связи/i.test(facts.publicContext)) {
    lines.push('Если в разговоре говорят, что кто-то отключился, а в списке он на месте, — не подтверждай; скажи, что у тебя он на связи.')
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
