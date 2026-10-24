import { expect, test, type Page } from '@playwright/test'

async function hear(page: Page, text: string) {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } }).__aisigame
    if (!controls) throw new Error('Нет мока')
    controls.hear(line, 1400)
  }, text)
}
async function answer(page: Page, player: string, text: string) {
  const group = page.getByRole('group', { name: new RegExp(`^${player}:`) })
  await expect(group.locator('button.buzzer')).toBeEnabled()
  await group.locator('button.buzzer').click()
  await hear(page, text)
}
async function board(page: Page) {
  await expect(page.getByRole('button', { name: 'Текст, 200', exact: true })).toBeEnabled()
}
async function startTable(page: Page) {
  await page.goto('/?mock=1')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await board(page)
  await page.getByRole('button', { name: 'Текст, 100', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Как звали первого римского императора?' })).toBeVisible()
}

test('стол: повтор минуса, замена на плюс и продолжение сохранённой апелляции', async ({ page }) => {
  await startTable(page)
  await answer(page, 'Игрок 1', 'Наполеон')
  const appeal = page.getByRole('button', { name: 'Апелляция', exact: true })
  await expect(appeal).toBeEnabled(); await appeal.click()
  await expect(page.getByRole('button', { name: 'Отвечаете' })).toBeDisabled()
  await expect(page.locator('.player.active', { hasText: 'Игрок 1' })).toBeVisible()
  await hear(page, 'Наполеон')
  await expect(appeal).toBeEnabled()
  await expect(page.getByRole('group', { name: 'Игрок 1: -100' })).toBeVisible()
  await appeal.click()
  await expect(page.locator('.player.active', { hasText: 'Игрок 1' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /Продолжить прошлую игру/ }).click()
  await expect(page.locator('.player.active', { hasText: 'Игрок 1' })).toBeVisible()
  await hear(page, 'Август')
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await board(page)
  await expect(page.getByRole('button', { name: 'Текст, 100, сыграно' })).toBeDisabled()
})

test('стол: после объявления ответа — апелляция двойным нажатием, одно нажатие ничего не меняет', async ({ page }) => {
  if (process.env.APPEAL_MOBILE) await page.setViewportSize({ width: 390, height: 844 })
  await startTable(page)
  // Здесь несколько действий и замеры геометрии; тест не проверяет длительность окна.
  await page.evaluate(() => (window as unknown as { __aisigame: { setAppealScale: (scale: number) => void } }).__aisigame.setAppealScale(4))
  await answer(page, 'Игрок 1', 'Наполеон')
  // Минус — кнопка апелляции доступна сразу.
  await expect(page.getByRole('group', { name: 'Игрок 1: -100' }).getByRole('button', { name: 'Апелляция' })).toBeEnabled()
  await answer(page, 'Игрок 2', 'Наполеон')
  await expect(page.getByRole('group', { name: 'Игрок 2: -100' })).toBeVisible()
  await answer(page, 'Игрок 3', 'Август')
  await board(page)
  await expect(page.getByText(/Правильный ответ:/).first()).toBeVisible()
  // Одно нажатие мало: кнопка меняется на «Подтвердите апелляцию» и ждёт вторую кнопку.
  const tile2 = page.getByRole('group', { name: 'Игрок 2: -100' })
  const wide = await tile2.getByRole('button', { name: 'Апелляция' }).boundingBox()
  await tile2.getByRole('button', { name: 'Апелляция' }).click()
  // Подтверждение — та же большая кнопка, во всю ширину плитки.
  const big = await tile2.getByRole('button', { name: 'Подтвердите апелляцию' }).boundingBox()
  await expect(tile2.getByRole('button', { name: 'Апелляция' })).toHaveCount(0)
  expect(Math.abs(big!.x - wide!.x)).toBeLessThan(2)
  expect(Math.abs(big!.y - wide!.y)).toBeLessThan(2)
  expect(Math.abs(big!.x + big!.width - (wide!.x + wide!.width))).toBeLessThan(2)
  if (process.env.APPEAL_SHOT) await page.screenshot({ path: process.env.APPEAL_SHOT })
  await expect(page.getByRole('group', { name: 'Игрок 2: -100' })).toBeVisible()
  await expect(page.getByText(/Апелляция принята/)).toHaveCount(0)
  // Второе нажатие той же кнопки подтверждает: поправка счёта без повторного ответа.
  await tile2.getByRole('button', { name: 'Подтвердите апелляцию' }).click()
  await expect(page.getByRole('group', { name: 'Игрок 2: 100' })).toBeVisible()
  // Двойная клавиша тоже подаёт апелляцию: левый Ctrl — кнопка первого игрока.
  await expect(page.getByRole('group', { name: 'Игрок 1: -100' })).toBeVisible()
  await page.keyboard.press('ControlLeft')
  await expect(page.getByRole('group', { name: 'Игрок 1: -100' }).getByRole('button', { name: 'Подтвердите апелляцию' })).toBeVisible()
  await page.keyboard.press('ControlLeft')
  await expect(page.getByText(/Апелляция принята/).first()).toBeVisible()
  // Подписи «Апелляции: …» под табло нет — она сдвигала вёрстку.
  await expect(page.getByText(/^Апелляции:/)).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await expect(page.locator('.player.active', { hasText: 'Игрок 1' })).toHaveCount(0)
  await board(page)
  for (const id of [1, 2, 3]) await expect(page.getByRole('group', { name: `Игрок ${id}: 100` })).toBeVisible()
})

test('конференция: заявка гостя, отключение выбора, reload гостя и замена результата у обоих', async ({ browser }) => {
  const context = await browser.newContext()
  const master = await context.newPage(), guest = await context.newPage()
  try {
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await master.getByRole('button', { name: 'Ссылка для игры' }).click()
    const dialog = master.getByRole('dialog', { name: 'Ссылка для игры' })
    const invite = new URL(await dialog.getByLabel('Ссылка для игроков').inputValue())
    invite.host = new URL(master.url()).host; invite.protocol = new URL(master.url()).protocol
    invite.searchParams.set('mock', '1')
    await dialog.getByRole('button', { name: 'Закрыть' }).click()
    await guest.goto(invite.href)
    await guest.getByLabel('Ваше имя').fill('Гость')
    await guest.getByRole('button', { name: 'Подключиться' }).click()
    await expect(guest.getByRole('button', { name: 'Я в игре' })).toBeEnabled()
    await guest.getByRole('button', { name: 'Я в игре' }).click()
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await guest.getByRole('button', { name: 'Текст, 100', exact: true }).click()
    // Buzz only after the read finished, otherwise the click is a false start.
    await expect(guest.getByText('Жмите кнопку')).toBeVisible()
    await answer(guest, 'Гость', 'Наполеон')
    // The mock voice runs on the master, matching the real mixed audio architecture.
    await hear(master, 'Наполеон')
    await expect(guest.getByRole('button', { name: 'Апелляция' })).toBeEnabled()
    await guest.getByRole('button', { name: 'Апелляция' }).click()
    await expect(master.getByRole('group', { name: 'Гость: -100' }).getByRole('button', { name: 'Отвечаете' })).toBeDisabled()
    await guest.reload()
    await guest.getByRole('button', { name: 'Подключиться' }).click()
    await expect(guest.getByRole('group', { name: 'Гость: -100' }).getByRole('button', { name: 'Отвечаете' })).toBeDisabled()
    await expect(master.getByRole('status').filter({ hasText: 'Гость отвечает' })).toBeVisible()
    await hear(master, 'Август')
    for (const page of [master, guest]) await expect(page.getByRole('group', { name: 'Гость: 100' })).toBeVisible()
    await expect(guest.getByRole('button', { name: 'Текст, 200', exact: true })).toBeEnabled()
  } finally { await context.close() }
})
