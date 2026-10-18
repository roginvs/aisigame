import { expect, test, type Page } from '@playwright/test'

// Пауза у гостя выглядит как у мастера: resumePath едет в снимке (эталон-подсветка остаётся).
test.setTimeout(120_000)
test('пауза для всех: оверлей «Пауза» у мастера и гостя, гость снимает паузу', async ({ browser }) => {
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
  // В паузе табло, разговор и карточку ведущей скрываем: остаются хедер и крупные карточки участников.
  await expect(master.locator('.play.is-paused')).toBeVisible({ timeout: 5_000 })
  await expect(joiner.locator('.play.is-paused')).toBeVisible({ timeout: 5_000 })
  await expect(master.locator('.play.is-paused > .stage')).toBeHidden()
  await expect(master.locator('.layout.is-paused > .talk')).toBeHidden()
  await expect(joiner.locator('.layout.is-paused > .talk')).toBeHidden()
  await expect(master.locator('.play.is-paused .conference-player')).toHaveCount(2)
  // Игрок снимает паузу: toggle паузы доступен всем.
  await joiner.getByRole('button', { name: 'Дальше' }).click()
  // После «Дальше» оба вернулись из паузы: главный экран снова рисуется (у обоих одинаково).
  await expect(master.locator('.play.is-paused')).toBeHidden({ timeout: 5_000 })
  await expect(master.locator('.board')).toBeVisible()
  await expect(joiner.locator('.board')).toBeVisible({ timeout: 5_000 })
  if (process.env.SHOT_DIR) {
    await master.screenshot({ path: `${process.env.SHOT_DIR}/sync-pause-master.png` })
    await joiner.screenshot({ path: `${process.env.SHOT_DIR}/sync-pause-joiner.png` })
  }
  await context.close()
})


async function setSpeechMs(page: Page, ms: number): Promise<void> {
  await page.evaluate((value) => {
    const controls = (window as unknown as { __aisigame?: { setSpeechMs: (ms: number) => void } }).__aisigame
    controls?.setSpeechMs(value)
  }, ms)
}
