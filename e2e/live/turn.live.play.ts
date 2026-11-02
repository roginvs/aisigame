import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Живой полный ход через контроллер и живой Jitsi. Только вручную:
 *   npm run live:turn                      — mini, сценарий answer (A отвечает, B говорит поверх)
 *   LIVE_SCENARIO=silent npm run live:turn — A молчит, B говорит
 *   LIVE_MODEL=mock npm run live:turn      — отладка шагов без расхода
 * Ключ берётся из OPENAI_API_KEY и не печатается.
 */
const live = process.env.AISIGAME_LIVE === '1'
const key = process.env.OPENAI_API_KEY ?? ''
const model = process.env.LIVE_MODEL ?? 'gpt-realtime-2.1-mini'
const scenario = process.env.LIVE_SCENARIO ?? 'answer'
const dir = new URL('./fixtures/', import.meta.url)
test.setTimeout(180_000)

/** Микрофон страницы — управляемый WebAudio: window.__say(base64 wav). */
const fakeMic = () => {
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const keep = ctx.createConstantSource()
  const g = ctx.createGain(); g.gain.value = 0; keep.connect(g); g.connect(dest); keep.start()
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (c) => {
    void ctx.resume()
    const out = new MediaStream()
    if (c && (c as MediaStreamConstraints).video) for (const t of (await orig({ video: (c as MediaStreamConstraints).video })).getVideoTracks()) out.addTrack(t)
    if (c && (c as MediaStreamConstraints).audio) out.addTrack(dest.stream.getAudioTracks()[0].clone())
    return out
  }
  ;(window as unknown as Record<string, unknown>).__say = async (b64: string) => {
    await ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer)
    src.connect(dest)
    return new Promise<void>((res) => { src.onended = () => res(); src.start() })
  }
}

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] })
  const page = await context.newPage()
  await page.addInitScript(fakeMic)
  return page
}

test(`живой ход: ${scenario}`, async ({ browser }) => {
  test.skip(!live || (model !== 'mock' && !key), 'AISIGAME_LIVE=1 и OPENAI_API_KEY')
  const a = (await readFile(new URL('turn-a.wav', dir))).toString('base64')
  const b = (await readFile(new URL('turn-b.wav', dir))).toString('base64')
  const master = await open(browser)
  const log: Array<{ t: number; text: string }> = []
  const t0 = Date.now()
  master.on('console', (m) => { if (m.text().startsWith('[aisigame')) log.push({ t: Date.now() - t0, text: m.text().replace(/sk-[\w-]+/g, 'sk-***') }) })
  await master.goto('/')
  await master.getByLabel('Модель').selectOption(model)
  if (model !== 'mock') await master.getByLabel('Ключ OpenAI').fill(key)
  await master.getByRole('radio', { name: 'Конференция' }).check()
  if (process.env.LIVE_JITSI) await master.getByLabel('Адрес Jitsi').fill(process.env.LIVE_JITSI)
  await master.getByLabel('Пакет вопросов').selectOption('demo')
  await master.getByLabel('Ваше имя').fill('Мастер')
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await master.getByRole('button', { name: 'Ссылка для игры' }).click({ timeout: 60_000 })
  const invite = new URL(await master.getByLabel('Ссылка для игроков').inputValue())
  await master.getByRole('button', { name: 'Закрыть' }).click()
  invite.protocol = 'http:'
  invite.host = new URL(master.url()).host
  const players: Record<'A' | 'B', Page> = { A: await open(browser), B: await open(browser) }
  for (const [name, page] of Object.entries(players)) {
    await page.goto(invite.href)
    await page.getByLabel('Ваше имя').fill(name === 'A' ? 'Анна' : 'Борис')
    await page.getByRole('button', { name: 'Подключиться' }).click()
    await expect(page.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Я в игре' }).click()
  }
  await master.getByRole('button', { name: 'Начать игру' }).click()
  const mark = (s: string) => log.push({ t: Date.now() - t0, text: `### ${s}` })
  mark('старт')
  // Кто бы ни выбирал — кликаем ячейку у мастера (выбор не голосом: экономим и не путаем слух).
  const cell = master.getByRole('button', { name: 'Текст, 100', exact: true })
  await expect(cell).toBeEnabled({ timeout: 60_000 })
  await cell.click().catch(() => undefined)
  for (const p of Object.values(players)) await p.getByRole('button', { name: 'Текст, 100', exact: true }).click({ timeout: 2000 }).catch(() => undefined)
  mark('выбран вопрос')
  const buzzA = players.A.getByRole('group', { name: /Анна:/ }).getByRole('button', { name: 'Жмите' })
  await expect(buzzA).toBeEnabled({ timeout: 60_000 })
  const scoreBefore = await master.locator('[role=group][aria-label^="Анна:"]').first().getAttribute('aria-label')
  await buzzA.click()
  mark('кнопка A')
  await master.waitForTimeout(600)
  const sayB = players.B.evaluate((w) => (window as unknown as { __say: (x: string) => Promise<void> }).__say(w), b)
  mark('B говорит')
  if (scenario === 'answer') {
    await master.waitForTimeout(400)
    mark('A говорит')
    await players.A.evaluate((w) => (window as unknown as { __say: (x: string) => Promise<void> }).__say(w), a)
    mark('A закончил')
  }
  await sayB
  mark('B закончил')
  // Ждём вердикт: счёт A сменился или ход ушёл.
  const scoreA = master.locator('[role=group][aria-label^="Анна:"]').first()
  await expect.poll(async () => scoreA.getAttribute('aria-label'), { timeout: 45_000 }).not.toBe(scoreBefore).catch(() => undefined)
  mark('после вердикта')
  await master.waitForTimeout(2500)
  const scoreAfter = await scoreA.getAttribute('aria-label')
  const scoreB = await master.locator('[role=group][aria-label^="Борис:"]').first().getAttribute('aria-label')
  const chat = await master.getByRole('complementary', { name: 'Разговор' }).innerText().catch(() => '')
  const usage = await master.evaluate(async () => (await import('/src/realtime/usage.ts')).getUsageSnapshot())
  const out = test.info().outputPath(`turn-${scenario}.log`)
  await writeFile(out, log.map((l) => `${l.t}\t${l.text}`).join('\n'))
  await writeFile(test.info().outputPath(`turn-${scenario}.chat.txt`), chat)
  console.log('SCORE', scoreBefore, '→', scoreAfter, '| B', scoreB)
  console.log('USAGE', JSON.stringify(usage.totals), 'usd', usage.usd.toFixed(4))
  console.log('LOG', out)
  for (const p of [master, ...Object.values(players)]) await p.context().close()
})
