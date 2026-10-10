import { gameConfig } from '../config.ts'

export type UsageTotals = {
  responses: number
  textIn: number
  cachedTextIn: number
  textOut: number
  audioIn: number
  cachedAudioIn: number
  audioOut: number
  imageIn: number
  cachedImageIn: number
}

export type UsageSnapshot = {
  totals: UsageTotals
  usd: number
}

const empty = (): UsageTotals => ({
  responses: 0,
  textIn: 0,
  cachedTextIn: 0,
  textOut: 0,
  audioIn: 0,
  cachedAudioIn: 0,
  audioOut: 0,
  imageIn: 0,
  cachedImageIn: 0,
})

const seen = new Set<string>()
const listeners = new Set<() => void>()
let totals = empty()
let snapshot: UsageSnapshot = { totals, usd: 0 }

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function record(value: Record<string, unknown>): boolean {
  const details = value.input_token_details
  const input = details && typeof details === 'object' ? (details as Record<string, unknown>) : {}
  const cachedRaw = input.cached_tokens_details
  const cached = cachedRaw && typeof cachedRaw === 'object' ? (cachedRaw as Record<string, unknown>) : {}
  const outputRaw = value.output_token_details
  const output = outputRaw && typeof outputRaw === 'object' ? (outputRaw as Record<string, unknown>) : {}

  let textIn = amount(input.text_tokens)
  let audioIn = amount(input.audio_tokens)
  let imageIn = amount(input.image_tokens)
  let cachedTextIn = amount(cached.text_tokens)
  let cachedAudioIn = amount(cached.audio_tokens)
  let cachedImageIn = amount(cached.image_tokens)
  const cachedTotal = amount(input.cached_tokens)
  const cachedKnown = cachedTextIn + cachedAudioIn + cachedImageIn
  if (cachedKnown === 0 && cachedTotal > 0) {
    if (audioIn > 0) cachedAudioIn = Math.min(cachedTotal, audioIn)
    else if (textIn > 0) cachedTextIn = Math.min(cachedTotal, textIn)
    else cachedImageIn = Math.min(cachedTotal, imageIn)
  }
  cachedTextIn = Math.min(cachedTextIn, textIn)
  cachedAudioIn = Math.min(cachedAudioIn, audioIn)
  cachedImageIn = Math.min(cachedImageIn, imageIn)

  let textOut = amount(output.text_tokens)
  let audioOut = amount(output.audio_tokens)
  const detailedIn = textIn + audioIn + imageIn
  const detailedOut = textOut + audioOut
  const inputTokens = amount(value.input_tokens)
  const outputTokens = amount(value.output_tokens)
  if (detailedIn === 0) textIn = inputTokens
  if (detailedOut === 0) textOut = outputTokens
  else if (outputTokens > detailedOut) textOut += outputTokens - detailedOut

  const added = textIn + audioIn + imageIn + textOut + audioOut
  if (added === 0) return false

  totals = {
    responses: totals.responses + 1,
    textIn: totals.textIn + textIn,
    cachedTextIn: totals.cachedTextIn + cachedTextIn,
    textOut: totals.textOut + textOut,
    audioIn: totals.audioIn + audioIn,
    cachedAudioIn: totals.cachedAudioIn + cachedAudioIn,
    audioOut: totals.audioOut + audioOut,
    imageIn: totals.imageIn + imageIn,
    cachedImageIn: totals.cachedImageIn + cachedImageIn,
  }
  return true
}

export function estimateUsd(usage: UsageTotals): number {
  const rates = gameConfig.rates
  const million = 1_000_000
  const freshText = Math.max(0, usage.textIn - usage.cachedTextIn)
  const freshAudio = Math.max(0, usage.audioIn - usage.cachedAudioIn)
  const freshImage = Math.max(0, usage.imageIn - usage.cachedImageIn)
  return (
    (freshText * rates.textIn +
      usage.cachedTextIn * rates.cachedTextIn +
      usage.textOut * rates.textOut +
      freshAudio * rates.audioIn +
      usage.cachedAudioIn * rates.cachedAudioIn +
      usage.audioOut * rates.audioOut +
      freshImage * rates.imageIn +
      usage.cachedImageIn * rates.cachedImageIn) /
    million
  )
}

function publish(): void {
  snapshot = { totals, usd: estimateUsd(totals) }
  for (const listener of listeners) listener()
}

export function recordResponseUsage(response: unknown): void {
  if (!response || typeof response !== 'object') return
  const body = response as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : ''
  if (id && seen.has(id)) return
  const usage = body.usage
  if (!usage || typeof usage !== 'object') return
  if (!record(usage as Record<string, unknown>)) return
  if (id) seen.add(id)
  publish()
}

export function resetUsage(): void {
  seen.clear()
  totals = empty()
  publish()
}

export function getUsageSnapshot(): UsageSnapshot {
  return snapshot
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) return `≈ $${usd.toFixed(4)}`
  if (usd < 1) return `≈ $${usd.toFixed(3)}`
  return `≈ $${usd.toFixed(2)}`
}

export function formatTokens(count: number): string {
  const value = Math.max(0, Math.round(count))
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${compact(value / 1000)}K`
  return `${compact(value / 1_000_000)}M`
}

function compact(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return String(rounded)
}

export function billedTokens(usage: UsageTotals): number {
  return usage.textIn + usage.audioIn + usage.imageIn + usage.textOut + usage.audioOut
}
