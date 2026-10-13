import type { SpecialState } from './types.ts'

/** Сохранённое состояние кота/аукциона; битое — null (игра продолжится с выбора). */
export function readSpecialState(value: unknown, roster?: Set<number>): SpecialState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x > 0 && (!roster || roster.has(x))
  const idOrNull = (x: unknown) => x === null || id(x)
  const ids = (x: unknown) => Array.isArray(x) && x.every(id)
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  const options = Array.isArray(v.options) && v.options.every((o) => o && typeof o === 'object' &&
    (((o as Record<string, unknown>).kind === 'pass') || (((o as Record<string, unknown>).kind === 'stake' || (o as Record<string, unknown>).kind === 'allIn') && num((o as Record<string, unknown>).amount))))
  const ok = (v.kind === 'cat' || v.kind === 'auction') && typeof v.questionId === 'string' && id(v.giverId) && idOrNull(v.recipientId) &&
    Array.isArray(v.stakeOptions) && v.stakeOptions.every(num) && (v.stake === null || num(v.stake)) && num(v.nominal) &&
    ids(v.order) && ids(v.passed) && idOrNull(v.leaderId) && (v.bid === null || num(v.bid)) && typeof v.allIn === 'boolean' && options &&
    Array.isArray(v.log) && v.log.every((line) => typeof line === 'string') && typeof v.unclear === 'string' &&
    idOrNull(v.awayPlayerId) && (v.awayFrom === null || v.awayFrom === 'staking' || v.awayFrom === 'bidding' || v.awayFrom === 'answering') && idOrNull(v.awayNextChooser)
  return ok ? (value as SpecialState) : null
}
