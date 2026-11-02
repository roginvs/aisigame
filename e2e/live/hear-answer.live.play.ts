import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

/**
 * Живой стенд «модель слышит только отвечающего». Только вручную:
 *   AISIGAME_LIVE=1 npx playwright test e2e/live/hear-answer.live.play.ts
 * Ключ берётся из OPENAI_API_KEY и не печатается. Модель — gpt-realtime-2.1-mini.
 * A отвечает с размышлением и самоисправлением, B (чужой игрок) говорит поверх.
 * Обе дорожки идут через настоящий createMicMixer с фокусом на A.
 */
const key = process.env.OPENAI_API_KEY
const live = process.env.AISIGAME_LIVE === '1'
const dir = new URL('./fixtures/', import.meta.url)

test.setTimeout(90_000)

test('живой ответ: модель судит A по смыслу, B не попадает в микс', async ({ page }) => {
  test.skip(!live || !key, 'AISIGAME_LIVE=1 и OPENAI_API_KEY')
  const a = (await readFile(new URL('a.wav', dir))).toString('base64')
  const b = (await readFile(new URL('b.wav', dir))).toString('base64')
  await page.goto('/')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  const r = await page.evaluate(async ({ key, a, b }) => {
    const { RealtimeClient } = await import('/src/realtime/client.ts')
    const { createMicMixer } = await import('/src/conference/audioMix.ts')
    const { getUsageSnapshot, resetUsage } = await import('/src/realtime/usage.ts')
    resetUsage()
    const ctx = new AudioContext()
    const voice = async (wav: string) => {
      const dest = ctx.createMediaStreamDestination()
      const src = ctx.createBufferSource()
      src.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(wav), (c) => c.charCodeAt(0)).buffer)
      src.connect(dest)
      return { dest, src }
    }
    const A = await voice(a)
    const B = await voice(b)
    const mixer = createMicMixer()
    const sync = () => mixer.update({
      remotes: [
        { key: 'ta', participantId: 'pA', stream: A.dest.stream, muted: false },
        { key: 'tb', participantId: 'pB', stream: B.dest.stream, muted: false },
      ],
      local: { participantId: 'host', stream: null, live: false },
      focus: 'pA',
    })
    const gains = sync()
    const client = new RealtimeClient({ model: 'gpt-realtime-2.1-mini' })
    const t0 = performance.now()
    const at = () => Math.round(performance.now() - t0)
    const vad: Array<{ kind: string; at: number }> = []
    const stopped: string[] = []
    const levels: Array<{ at: number; bGain: number; bPre: number; bPost: number; aPost: number }> = []
    let sampler: ReturnType<typeof setInterval> | undefined
    try {
      await client.connect(key, { captureMic: false })
      client.setInputStream(mixer.outputStream()!)
      client.onSpeechStopped = ({ itemId }) => { vad.push({ kind: 'stopped', at: at() }); if (itemId) stopped.push(itemId) }
      client.setMicEnabled(true)
      await ctx.resume()
      sampler = setInterval(() => {
        sync()
        const l = mixer.levels()
        const lb = l.find((x) => x.key === 'remote-tb')!
        const la = l.find((x) => x.key === 'remote-ta')!
        levels.push({ at: at(), bGain: lb.gain, bPre: lb.rms, bPost: lb.postRms, aPost: la.postRms })
      }, 100)
      const aEnd = new Promise<number>((res) => { A.src.onended = () => res(at()) })
      const startA = at()
      A.src.start()
      setTimeout(() => B.src.start(), 1000)
      const aEndedAt = await aEnd
      const waitUntil = performance.now() + 6000
      while (performance.now() < waitUntil && !vad.some((v) => v.at >= aEndedAt - 300)) await new Promise((s) => setTimeout(s, 100))
      client.setMicEnabled(false)
      const itemId = stopped.at(-1)
      if (!itemId) throw new Error('нет speech_stopped')
      const ref = client.audioReference(itemId)
      const ready = await client.waitForAudioItem(ref, performance.now() + 1500)
      if (!ready.ready) throw new Error(ready.reason)
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 15_000)
      const call = await client.requestAudioJudgment({ requestId: `live-${Date.now()}`, questionId: 'live', playerId: 1,
        attemptId: 1, turn: 1, role: 'primary', audio: ref },
      'Оцени только приложенное аудио, засчитывай последний окончательный вариант игрока, размышления вслух и самоисправление допустимы. Вопрос: Как называются четырёхугольники, у которых все стороны равны и все углы прямые? (во множественном числе). Эталонные ответы: квадраты. Шум/тишина: unintelligible. Верни submitAnswerJudgment с questionId=live, playerId=1, attemptId=1, status, дословным heard и коротким reason.', abort.signal)
      await new Promise((s) => setTimeout(s, 800))
      return { startA, aEndedAt, vad, stoppedCount: stopped.length, levels, initialGains: [...gains.gains], fallback: gains.fallback,
        args: call.arguments, usage: getUsageSnapshot(), sessionMs: at() }
    } finally {
      clearInterval(sampler)
      client.stopSession()
      mixer.dispose()
      await ctx.close()
    }
  }, { key: key!, a, b })
  console.log('LIVE', JSON.stringify({ ...r, levels: undefined }))
  const bSpeaking = r.levels.filter((l) => l.bPre > 0.01)
  console.log(`B говорил ${bSpeaking.length} отсчётов, max bPost ${Math.max(...r.levels.map((l) => l.bPost))}, max aPost ${Math.max(...r.levels.map((l) => l.aPost))}`)
  // (b) B в миксе модели — никогда.
  expect(bSpeaking.length).toBeGreaterThan(5)
  expect(r.levels.every((l) => l.bGain === 0 && l.bPost < 1e-4)).toBe(true)
  expect(r.fallback).toBe(false)
  // (c) Коммит не раньше конца речи A (B ничего не оборвал).
  const early = r.vad.filter((v) => v.kind === 'stopped' && v.at < r.aEndedAt - 300)
  console.log('ранние speech_stopped', JSON.stringify(early))
  // (a) Вердикт по смыслу.
  expect(JSON.stringify(r.args)).toMatch(/"status"\s*:\s*"correct"/)
  expect(early).toHaveLength(0)
})
