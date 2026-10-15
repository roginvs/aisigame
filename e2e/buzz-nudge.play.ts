import { expect, test, type Page } from '@playwright/test'

// Локальная подсказка «жми кнопку»: голос игрока во время чтения/окна кнопки → его кнопка мигает
// только на его экране. Микрофон подменяем `window.__aisigameNudge.setLevel` (демо-хук).
test.setTimeout(120_000)
test('речь без кнопки: своя кнопка трижды мигает только у себя, мастер не видит', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const master = await context.newPage()
  const joiner = await context.newPage()
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
  await joiner.goto(invite.href)
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
  await joiner.getByRole('button', { name: 'Я готов' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  const cell = joiner.getByRole('button', { name: 'Выбор, 100' })
  await expect(cell).toBeEnabled({ timeout: 30_000 })
  await setSpeechMs(master, 20_000)
  await cell.click()
  await expect(joiner.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 30_000 })

  // Короткий стук — не мигает.
  await setLevel(joiner, 0.08)
  await joiner.waitForTimeout(200)
  await setLevel(joiner, 0)
  await joiner.waitForTimeout(700)
  await expect(joiner.locator('.buzz-nudge')).toHaveCount(0)

  // Речь дольше 0,6 с — мигает своя кнопка, у мастера ничего.
  const box = await joiner.locator('.conference-player.self .buzzer').boundingBox()
  await setLevel(joiner, 0.06)
  await expect(joiner.locator('.conference-player.self .buzzer.buzz-nudge')).toHaveCount(1, { timeout: 3_000 })
  await peak(joiner)
  await shot(joiner, 'nudge-mid')
  await resume(joiner)
  await expect(master.locator('.buzz-nudge')).toHaveCount(0)
  expect(await joiner.locator('.conference-player.self .buzzer').boundingBox()).toEqual(box)
  await setLevel(joiner, 0)
  await expect(joiner.locator('.buzz-nudge')).toHaveCount(0, { timeout: 3_000 })
  await shot(joiner, 'nudge-after')

  // Телефон: тот же экран узким, после cooldown 5 с — снова мигает.
  await joiner.setViewportSize({ width: 390, height: 844 })
  await joiner.waitForTimeout(5_000)
  await setLevel(joiner, 0.06)
  await expect(joiner.locator('.conference-player.self .buzzer.buzz-nudge')).toHaveCount(1, { timeout: 3_000 })
  await peak(joiner)
  await shot(joiner, 'nudge-mobile-mid')
  await resume(joiner)
  await setLevel(joiner, null)
  await context.close()
})

/** Кадр на пике вспышки: анимацию кнопки ставим на паузу в 35% первого цикла. */
async function peak(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if ((animation as CSSAnimation).animationName !== 'buzz-nudge') continue
      animation.pause()
      animation.currentTime = 157
    }
  })
}

async function resume(page: Page): Promise<void> {
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play() })
}

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` })
}

async function setLevel(page: Page, level: number | null): Promise<void> {
  await page.evaluate((value) => window.__aisigameNudge?.setLevel(value), level)
}

async function setSpeechMs(page: Page, ms: number): Promise<void> {
  await page.evaluate((value) => {
    const controls = (window as unknown as { __aisigame?: { setSpeechMs: (ms: number) => void } }).__aisigame
    controls?.setSpeechMs(value)
  }, ms)
}
