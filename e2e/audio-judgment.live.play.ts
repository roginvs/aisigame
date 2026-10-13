import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// Opt-in only. Never commit a key, recording or the user's actual speech.
const key = process.env.AISIGAME_OPENAI_KEY
const fixturePath = process.env.AISIGAME_AUDIO_FIXTURE
const question = process.env.AISIGAME_AUDIO_QUESTION
const answers = process.env.AISIGAME_AUDIO_ANSWERS
const expected = process.env.AISIGAME_AUDIO_EXPECTED_STATUS || 'correct'

test.describe.configure({ mode: 'serial' })
for (const model of ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1']) {
  test(`live committed WebRTC audio reference: ${model}`, async ({ page }, info) => {
    test.skip(!key || !fixturePath || !question || !answers, 'Requires an explicit key and labelled speech fixture')
    const wav = (await readFile(fixturePath!)).toString('base64')
    await page.goto('/')
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    const result = await page.evaluate(async ({ key, wav, model, question, answers }) => {
      const { RealtimeClient } = await import('/src/realtime/client.ts')
      const { getTrace } = await import('/src/debug/trace.ts')
      const client = new RealtimeClient({ model })
      const context = new AudioContext()
      const destination = context.createMediaStreamDestination()
      const source = context.createBufferSource()
      source.buffer = await context.decodeAudioData(Uint8Array.from(atob(wav), (c) => c.charCodeAt(0)).buffer)
      source.connect(destination)
      const startedAt = performance.now()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await client.connect(key, { captureMic: false })
        client.setInputStream(destination.stream)
        const stopped = new Promise<string>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('No speech_stopped from fixture')), 15_000)
          client.onSpeechStopped = ({ itemId }) => { if (itemId) { clearTimeout(timeout); resolve(itemId) } }
        })
        client.setMicEnabled(true)
        await context.resume()
        source.start()
        const itemId = await stopped
        client.setMicEnabled(false)
        const ref = client.audioReference(itemId)
        const ready = await client.waitForAudioItem(ref, performance.now() + 1500)
        if (!ready.ready) throw new Error(ready.reason)
        const abort = new AbortController()
        timeout = setTimeout(() => abort.abort(), 12_000)
        const call = await client.requestAudioJudgment({ requestId: `live-${Date.now()}`, questionId: 'live', playerId: 1,
          attemptId: 1, turn: 1, role: 'primary', audio: ref },
        `Оцени только приложенное аудио. Вопрос: ${question}. Эталонные ответы: ${answers}. Альтернативный фактически верный ответ допустим. Шум/тишина: unintelligible, heard пустой. Не угадывай по эталону. Верни submitAnswerJudgment с questionId=live, playerId=1, attemptId=1, status, дословным heard и коротким reason.`, abort.signal)
        const events = getTrace().filter((e) => e.kind === 'in' &&
          /input_audio_buffer\.(speech_|committed)|conversation.item.(added|created|done)|response.(created|done)/.test(e.title))
          .map((e) => ({ type: e.title, at: e.at }))
        return { arguments: call.arguments, elapsedMs: Math.round(performance.now() - startedAt), events }
      } finally {
        clearTimeout(timeout)
        client.stopSession()
        source.disconnect()
        destination.stream.getTracks().forEach((track) => track.stop())
        await context.close()
      }
    }, { key: key!, wav, model, question: question!, answers: answers! })
    expect(result.arguments).toMatchObject({ questionId: 'live', playerId: 1, attemptId: 1, status: expected })
    await info.attach('audio-reference-events.json', { body: JSON.stringify({ model, ...result }, null, 2), contentType: 'application/json' })
  })
}
