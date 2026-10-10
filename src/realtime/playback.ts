export type PlaybackWait = 'finish' | 'fallback' | 'keep'

export type HostAudioTimers = {
  /** Короткий запас: воспроизведение так и не началось. */
  fallback: boolean
  /** Жёсткий предел, если `stopped` не придёт. */
  hard: boolean
}

/** После response.done: звук уже кончился, его ещё не было, или он всё ещё играет. */
export function playbackWait(speech: { started: boolean; ended: boolean }): PlaybackWait {
  if (speech.ended) return 'finish'
  if (speech.started) return 'keep'
  return 'fallback'
}

/**
 * Короткий запас ставится, только если к концу генерации звук ещё не начинался.
 * Пока его нет, жёсткий предел снимается: иначе остаток старого предела
 * обрежет фразу раньше этих 8 с.
 */
export function timersAfterResponseDone(
  speech: { started: boolean; ended: boolean },
  timers: HostAudioTimers,
): { wait: PlaybackWait; timers: HostAudioTimers } {
  const wait = playbackWait(speech)
  if (wait === 'finish') return { wait, timers: { fallback: false, hard: false } }
  if (wait === 'keep') return { wait, timers: { fallback: false, hard: timers.hard } }
  return { wait, timers: { fallback: true, hard: false } }
}

/**
 * Звук пошёл. 8 с снимаются, даже если их поставили на response.done,
 * когда `started` ещё не было. Жёсткий предел снова держит ход до `stopped`.
 * Если воспроизведение уже отмечено концом, таймер сверки фразы не трогаем.
 */
export function timersAfterPlaybackStarted(timers: HostAudioTimers, ended: boolean): HostAudioTimers {
  if (ended) return timers
  return { fallback: false, hard: true }
}

/**
 * Сколько ждать `cleared` предыдущей реплики, прежде чем всё же создать новую.
 * Дольше не держим: если сброс так и не пришёл, фраза не должна замолчать.
 */
export const outputFlushWaitMs = 400

export type OutputCut = 'finish' | 'release' | 'ignore'

export type OutputCutState = {
  /** Новая фраза ещё не создана: ждём сброс предыдущей. */
  holdingForFlush: boolean
  started: boolean
  liveResponseId: string | null
  itemId: string | null
  /** Ответ, который этот сброс не должен оборвать. */
  ignoreResponseId: string | null
}

export type OutputCutEvent =
  | { kind: 'cleared'; responseId: string }
  | { kind: 'truncated'; itemId: string }

function isPreviousResponse(state: OutputCutState, responseId: string): boolean {
  return Boolean(
    responseId &&
      state.ignoreResponseId &&
      responseId === state.ignoreResponseId &&
      responseId !== state.liveResponseId,
  )
}

/**
 * Сброс или обрез буфера.
 * `release` — сброс предыдущей реплики, новую ещё можно создать.
 * `finish` — оборвана уже начатая фраза: не ждать `stopped` и жёсткий предел.
 * `ignore` — чужой ответ, текущее чтение ещё играет.
 */
export function outputCut(state: OutputCutState, event: OutputCutEvent): OutputCut {
  if (event.kind === 'truncated') {
    if (!state.started) return 'ignore'
    if (state.itemId && event.itemId && event.itemId !== state.itemId) return 'ignore'
    return 'finish'
  }
  if (isPreviousResponse(state, event.responseId)) {
    return state.holdingForFlush && !state.started ? 'release' : 'ignore'
  }
  if (state.holdingForFlush && !state.started) return 'release'
  if (state.started && (!event.responseId || !state.liveResponseId || event.responseId === state.liveResponseId)) {
    return 'finish'
  }
  return 'ignore'
}
