import { devices, expect, test, type Page } from '@playwright/test'

// Полоска таймера во время выбора вопроса не должна сдвигать вёрстку: табло,
// игроки и «Разговор» остаются на месте, пока она появляется и бежит.
async function boxes(page: Page) {
  return page.evaluate(() => {
    const pick = (selector: string) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
    }
    return {
      board: pick('[aria-label="Игровое поле"]'),
      players: pick('.players'),
      talk: pick('.talk'),
      question: pick('.question'),
      heading: pick('.question h2'),
      media: pick('.question-media'),
      timer: pick('.timer-bar'),
      scrollH: document.documentElement.scrollHeight,
    }
  })
}

async function check(page: Page) {
  await page.goto('/?mock=1')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('grid', { name: 'Игровое поле' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Текст, 100', exact: true })).toBeEnabled()
  const before = await boxes(page)
  const samples = [before]
  const until = Date.now() + 25_000
  while (Date.now() < until) {
    await page.waitForTimeout(400)
    const now = await boxes(page)
    samples.push(now)
    if (samples.filter((sample) => sample.timer).length >= 4) break
  }
  for (const sample of samples) {
    expect(sample.board).toEqual(before.board)
    expect(sample.players).toEqual(before.players)
    expect(sample.talk).toEqual(before.talk)
    expect(sample.scrollH).toBe(before.scrollH)
  }

  // Выбрали вопрос: ведущая читает, затем внизу вопроса появляется и бежит полоска.
  await page.getByRole('button', { name: 'Текст, 100', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Как звали первого римского императора?' })).toBeVisible()
  const reading = await boxes(page)
  const asked: Awaited<ReturnType<typeof boxes>>[] = []
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(200)
    const now = await boxes(page)
    if (!now.heading) break
    asked.push(now)
    if (asked.filter((sample) => sample.timer).length >= 6) break
  }
  expect(asked.some((sample) => sample.timer)).toBe(true)
  // Вопрос встаёт ровно на место табло — переход тоже без скачка.
  expect(reading.question).toEqual(before.board)
  for (const sample of asked) {
    expect(sample.question).toEqual(reading.question)
    expect(sample.heading).toEqual(reading.heading)
    expect(sample.players).toEqual(reading.players)
    expect(sample.talk).toEqual(reading.talk)
    expect(sample.scrollH).toBe(reading.scrollH)
  }
}

test('выбор вопроса: полоска таймера не сдвигает вёрстку (компьютер)', async ({ page }) => {
  await check(page)
})

const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13']
test.describe('телефон', () => {
  test.use(phone)
  test('выбор вопроса: полоска таймера не сдвигает вёрстку (телефон)', async ({ page }) => {
    await check(page)
  })
})
