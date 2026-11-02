import { expect, test, type CDPSession, type Page } from '@playwright/test'

/**
 * Горячий цикл на мастере в ожидании.
 * Повторный замер 2 ноября 2026, тот же зонд, 5 секунд, headless Chromium:
 * до 9eaedac (c16a628): лобби raf 301, commits 7, script 98 мс, task 203 мс; пауза raf 301, commits 6, script 119, task 230.
 * сразу после 9eaedac (кадр ещё крутился, работа реже): лобби raf 301, commits 7, script 63, task 107; пауза raf 300, commits 6, script 47, task 83.
 * текущий master, requestAnimationFrame снят: лобби raf 1, commits 7, script 62, task 80; пауза raf 0, commits 6, script 51, task 63.
 */
const WINDOW_MS = 5_000
const MAX_RAF = 20
const MAX_COMMITS = 40
const MAX_SCRIPT_MS = 150
const MAX_TASK_MS = 160

test.setTimeout(90_000)

test('мастер в лобби и на паузе не крутит кадр и не жжёт скрипт', async ({ page }) => {
  await page.addInitScript(() => {
    let raf = 0
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => orig((t) => {
      raf += 1
      return cb(t)
    })
    let commits = 0
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      checkDCE() {},
      supportsFiber: true,
      renderers: new Map(),
      onScheduleFiberRoot() {},
      onCommitFiberRoot() { commits += 1 },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      inject() { return 1 },
      injectProfilingHooks() {},
    }
    window.__cpuProbe = () => ({ raf, commits })
  })

  await page.goto('/?mock=1&transport=broadcast')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByRole('radio', { name: 'Конференция' }).check()
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByLabel('Ваше имя').fill('Мастер')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await page.getByRole('button', { name: 'Ссылка для игры' }).waitFor()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await expectSample(page, cdp, 'lobby')
  await page.getByRole('button', { name: 'Пауза' }).click()
  await expect(page.locator('.play.is-paused')).toBeVisible()
  await expectSample(page, cdp, 'pause')
})

async function expectSample(page: Page, cdp: CDPSession, label: string): Promise<void> {
  const before = await page.evaluate(() => window.__cpuProbe())
  const m0 = await cdp.send('Performance.getMetrics')
  await page.waitForTimeout(WINDOW_MS)
  const after = await page.evaluate(() => window.__cpuProbe())
  const m1 = await cdp.send('Performance.getMetrics')
  const delta = (name: string) => {
    const read = (list: { metrics: Array<{ name: string; value: number }> }) =>
      list.metrics.find((item) => item.name === name)?.value ?? 0
    return (read(m1) - read(m0)) * 1000
  }
  const raf = after.raf - before.raf
  const commits = after.commits - before.commits
  const scriptMs = delta('ScriptDuration')
  const taskMs = delta('TaskDuration')
  console.log(`cpu ${label}: raf ${raf}, commits ${commits}, script ${scriptMs.toFixed(0)} мс, task ${taskMs.toFixed(0)} мс`)
  expect(raf, `${label} requestAnimationFrame`).toBeLessThanOrEqual(MAX_RAF)
  expect(commits, `${label} React commits`).toBeGreaterThan(0)
  expect(commits, `${label} React commits`).toBeLessThanOrEqual(MAX_COMMITS)
  expect(scriptMs, `${label} ScriptDuration мс`).toBeLessThanOrEqual(MAX_SCRIPT_MS)
  expect(taskMs, `${label} TaskDuration мс`).toBeLessThanOrEqual(MAX_TASK_MS)
}

declare global {
  interface Window {
    __cpuProbe: () => { raf: number; commits: number }
  }
}
