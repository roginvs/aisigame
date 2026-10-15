import { expect, test, type Page } from '@playwright/test'

// Пауза у гостя выглядит как у мастера: resumePath едет в снимке (эталон-подсветка остаётся).
test.setTimeout(120_000)
test('карточка ведущей одинакова; пауза на объявлении ответа: у гостя подсветка верного варианта как у мастера', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
  const master = await context.newPage()
  const joiner = await context.newPage()
  await master.goto('/?mock=1&transport=broadcast')
  await master.getByLabel('Модель').selectOption('mock')
  await master.getByRole('radio', { name: 'Конференция' }).check()
  await master.getByLabel('Пакет вопросов').selectOption('demo')
  await master.getByLabel('Ваше имя').fill('Мастер')
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await master.getByRole('button', { name: 'Ссылка для игры' }).click()
  const invite = await master.getByLabel('Ссылка для игроков').inputValue()
  await master.getByRole('button', { name: 'Закрыть' }).click()
  const url = new URL(invite)
  const base = new URL(master.url())
  url.protocol = base.protocol
  url.host = base.host
  await joiner.goto(url.href)
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
  await joiner.getByRole('button', { name: 'Я готов' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  const cell = joiner.getByRole('button', { name: 'Выбор, 100' })
  await expect(cell).toBeEnabled({ timeout: 30_000 })
  await cell.click()
  // Никто не жмёт: время выходит, ведущая называет верный вариант (подсветка), говорит долго.
  await expect(joiner.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 20_000 })
  // Карточка ведущей одинакова: подсказка «Меньше слышать» мастера едет в снимке.
  const hostText = (page: Page) => page.locator('.host').innerText().then((text) => text.replace(/ОПА|МС/g, '').replace(/\s+/g, ' ').trim())
  await expect.poll(async () => (await hostText(joiner)) === (await hostText(master)), { timeout: 3_000 }).toBe(true)
  if (process.env.SHOT_DIR) {
    await master.locator('.talk').screenshot({ path: `${process.env.SHOT_DIR}/status-master-after.png` })
    await joiner.locator('.talk').screenshot({ path: `${process.env.SHOT_DIR}/status-joiner-after.png` })
  }
  await setSpeechMs(master, 20_000)
  // Ведущая объявляет (табло уже открыто для выбора), пауза посреди объявления.
  await expect(master.getByRole('button', { name: 'Выбор, 100, сыграно' })).toBeVisible({ timeout: 30_000 })
  await master.getByRole('button', { name: 'Пауза' }).click()
  await expect(joiner.getByText('Пауза', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
  // В паузе вопрос с подсветкой верного варианта — у мастера и у гостя одинаково.
  await expect(master.locator('.choices .is-right')).toBeVisible()
  await expect(joiner.locator('.choices .is-right')).toBeVisible({ timeout: 5_000 })
  await expect(joiner.locator('.choices .is-right')).toHaveText(/Звёздные войны/)
  if (process.env.SHOT_DIR) {
    await master.screenshot({ path: `${process.env.SHOT_DIR}/sync-pause-master.png` })
    await joiner.screenshot({ path: `${process.env.SHOT_DIR}/sync-pause-joiner.png` })
  }
  await context.close()
})

async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } }).__aisigame
    if (!controls) throw new Error('нет заглушки ведущей')
    controls.hear(line, 1400)
  }, text)
}

async function setSpeechMs(page: Page, ms: number): Promise<void> {
  await page.evaluate((value) => {
    const controls = (window as unknown as { __aisigame?: { setSpeechMs: (ms: number) => void } }).__aisigame
    controls?.setSpeechMs(value)
  }, ms)
}
