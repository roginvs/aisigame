import type { AudioReference } from './audioItems.ts'
export type JudgmentInputMode = 'text' | 'shadow' | 'audio'
export type JudgmentSource = 'text' | 'audio'
export type JudgmentCapabilities = { isolatedAudioReference: boolean; parallelOutOfBand: boolean; model: string }
export type JudgeRequestContext = {
  requestId: string
  questionId: string
  playerId: number
  attemptId: number
  turn: number
  role: 'primary' | 'shadow'
  audio: AudioReference
}

/** Models are opted in explicitly. No provider/model guessing or extra key. */
export function audioJudgmentCapable(model: string): boolean {
  return model === 'gpt-realtime-2.1-mini' || model === 'gpt-realtime-2.1'
}

export const defaultJudgmentModes: Readonly<Record<string, JudgmentInputMode>> = {
  'gpt-realtime-2.1-mini': 'audio',
  'gpt-realtime-2.1': 'audio',
}

/** User preference; no server references or game-state data. */
export const judgmentModeStorageKey = 'aisigame.judgmentInputMode'

export function judgmentModeFromUrl(href: string, modelId?: string, storage?: Pick<Storage, 'getItem'>): JudgmentInputMode {
  const mode = new URL(href).searchParams.get('judge')
  if (mode === 'audio' || mode === 'shadow' || mode === 'text') return mode
  if (mode !== null) return 'text'
  try {
    const saved = storage?.getItem(judgmentModeStorageKey)
    if (saved === 'audio' || saved === 'text') return saved
  } catch { /* Preference remains usable for this page when storage is unavailable. */ }
  return modelId ? defaultJudgmentModes[modelId] ?? 'audio' : 'audio'
}

export function writeJudgmentMode(mode: 'text' | 'audio', storage: Pick<Storage, 'setItem'>): void {
  try { storage.setItem(judgmentModeStorageKey, mode) } catch { /* Current page still switches. */ }
}
