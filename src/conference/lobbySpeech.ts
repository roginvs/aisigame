import type { QuestionPack } from '../game/types.ts'
import type { GameVoice } from '../realtime/client.ts'
import type { RosterEntry } from './roster.ts'

/** Быстрые вход/сверка/ready собираются в одну реплику, а не перебивают друг друга. */
export const LOBBY_SPEECH_MIN_INTERVAL_MS = 10_000
/** Даже без изменений ведущая иногда поддерживает живое ожидание. */
export const LOBBY_IDLE_INTERVAL_MS = 15_000

export type LobbySpeechFacts = {
  kind: 'opened' | 'update' | 'idle'
  packName: string
  packSummary: string
  roster: RosterEntry[]
  waitingForMaster?: boolean
}

export function lobbySpeechInstructions(facts: LobbySpeechFacts): string {
  const lines: string[] = [
    'Ты ведущая в лобби онлайн-игры до старта партии. Тон тёплый, чуть кокетливый.',
    'Не читай проценты загрузки по одному. Не проси мастера нажать «Начать игру».',
    'Можно собрать несколько событий в одну фразу, если они пришли подряд.',
    'Ты слышишь недавний разговор игроков: можешь коротко и естественно его прокомментировать, ответить или поддержать беседу.',
    'Не перетягивай разговор на себя: вся реплика — не больше двух коротких предложений.',
  ]
  if (facts.kind === 'idle') {
    lines.push(
      'Статусы не изменились. Если игроки недавно о чём-то говорили, лучше коротко подхвати их разговор.',
      'Иначе скажи одну очень короткую живую фразу ожидания. Не пересказывай снова весь состав и готовность.',
    )
  } else {
    lines.push('Скажи коротко и по-человечески о новом событии; при желании естественно свяжи его с недавним разговором.')
  }
  if (facts.kind === 'opened') {
    lines.push(`Игра создана. Пакет: «${facts.packName}». ${facts.packSummary}`)
    lines.push('Скажи, что ждём игроков по ссылке.')
  }
  lines.push('Состав и статусы:')
  for (const entry of facts.roster.filter((item) => !item.hidden)) {
    const role = entry.isMaster ? 'мастер' : 'игрок'
    const load =
      entry.hashOk ? 'пакет сверен' : entry.percent >= 100 ? 'файл собран, ждёт сверки' : `качает (${entry.percent}%)`
    const ready = entry.ready ? ', готов' : ''
    lines.push(`- ${entry.name} (${role}): ${load}${ready}`)
  }
  if (facts.waitingForMaster) {
    lines.push('Мастер-игрок ещё не в комнате — можно коротко сказать, что ждём его.')
  }
  return lines.join('\n')
}

let lobbyTurn = 0

export function requestLobbySpeech(client: GameVoice, facts: LobbySpeechFacts): void {
  lobbyTurn += 1
  const instructions = lobbySpeechInstructions(facts)
  client.requestSpeech('lobby', lobbyTurn, instructions)
}

export function packLobbySummary(pack: QuestionPack): string {
  const rounds = pack.rounds.length
  const questions = pack.questions.length
  const final = pack.rounds.some((round) => round.kind === 'final')
  return `${rounds} раунд(ов), ${questions} вопрос(ов)${final ? ', есть финал' : ''}.`
}
