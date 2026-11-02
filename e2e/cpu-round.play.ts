import { expect, test, type CDPSession, type Page } from '@playwright/test'

/**
 * CPU в раунде: фейковые медиа, ухо ведущей слушает.
 * 2 ноября 2026, 5 с, headless Chromium, после снятия кадра у Countdown:
 * выбор: raf 0, commits 6, script 79 мс, task 243 мс.
 * вопрос: raf 0, commits 16, script 97 мс, task 143 мс.
 * Раньше вопрос давал ~300 raf и ~308 рендеров: Countdown делал setState на каждом кадре.
 * Task на выборе (220–246 мс) — не этот кадр: raf 0 и 6 рендеров. Script 79 мс —
 * холст индикатора модели раз в 100 мс (`levelUiSampleMs`, 320 столбцов). Остаток TaskDuration
 * сверх script — живая конференция двух участников (fake media, уровни Jitsi, окно слушания), не React.
 */
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } })
test.setTimeout(120_000)

const MAX_RAF = 20
const MAX_COMMITS = 40

const probe = () => {
  let raf = 0
  const orig = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => orig((t) => { raf += 1; return cb(t) })
  let commits = 0
  ;(window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    checkDCE() {}, supportsFiber: true, renderers: new Map(), onScheduleFiberRoot() {},
    onCommitFiberRoot() { commits += 1 }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, inject() { return 1 }, injectProfilingHooks() {},
  }
  ;(window as unknown as Record<string, unknown>).__cpuProbe = () => ({ raf, commits })
}

test('мастер в раунде: таймер выбора и индикаторы', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] })
  const master = await context.newPage()
  const joiner = await context.newPage()
  await master.addInitScript(probe)
  await master.goto('/?mock=1&transport=broadcast')
  await master.getByLabel('Модель').selectOption('mock')
  await master.getByRole('radio', { name: 'Конференция' }).check()
  await master.getByLabel('Пакет вопросов').selectOption('demo')
  await master.getByLabel('Ваше имя').fill('Мастер')
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await master.getByRole('button', { name: 'Ссылка для игры' }).click()
  const invite = new URL(await master.getByLabel('Ссылка для игроков').inputValue())
  await master.getByRole('button', { name: 'Закрыть' }).click()
  const base = new URL(master.url())
  invite.protocol = base.protocol
  invite.host = base.host
  invite.searchParams.set('mock', '1')
  invite.searchParams.set('transport', 'broadcast')
  await joiner.goto(invite.toString())
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
  await joiner.getByRole('button', { name: 'Я в игре' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(master.getByTestId('host-ear')).toHaveAttribute('data-ear', 'listening', { timeout: 30_000 })
  const cdp = await master.context().newCDPSession(master)
  await cdp.send('Performance.enable')
  const s = await sample(master, cdp)
  console.log(`cpu round(choosing): raf ${s.raf}, commits ${s.commits}, script ${s.script} мс, task ${s.task} мс`)
  expect(s.raf, 'выбор requestAnimationFrame').toBeLessThanOrEqual(MAX_RAF)
  expect(s.commits, 'выбор React commits').toBeLessThanOrEqual(MAX_COMMITS)
  // Гость берёт первый вопрос: чтение и кнопка, полоска таймера.
  await joiner.locator('.board button:not([disabled])').first().click()
  await master.waitForTimeout(1500)
  const q = await sample(master, cdp)
  console.log(`cpu round(question): raf ${q.raf}, commits ${q.commits}, script ${q.script} мс, task ${q.task} мс`)
  expect(q.raf, 'вопрос requestAnimationFrame').toBeLessThanOrEqual(MAX_RAF)
  expect(q.commits, 'вопрос React commits').toBeLessThanOrEqual(MAX_COMMITS)
  await context.close()
})

async function sample(page: Page, cdp: CDPSession) {
  const read = (l: { metrics: Array<{ name: string; value: number }> }, n: string) => l.metrics.find((m) => m.name === n)?.value ?? 0
  const b = await page.evaluate(() => (window as unknown as { __cpuProbe: () => { raf: number; commits: number } }).__cpuProbe())
  const m0 = await cdp.send('Performance.getMetrics')
  await page.waitForTimeout(5000)
  const a = await page.evaluate(() => (window as unknown as { __cpuProbe: () => { raf: number; commits: number } }).__cpuProbe())
  const m1 = await cdp.send('Performance.getMetrics')
  const d = (n: string) => Math.round((read(m1, n) - read(m0, n)) * 1000)
  return { raf: a.raf - b.raf, commits: a.commits - b.commits, script: d('ScriptDuration'), task: d('TaskDuration') }
}
