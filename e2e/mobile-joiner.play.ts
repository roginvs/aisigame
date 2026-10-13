import { devices, expect, test, type Browser, type Page } from '@playwright/test'

// Non-master player on a phone: board visible at the start of the match, buzzer works by touch.
async function joinOnPhone(browser: Browser, device: string) {
  const { defaultBrowserType: _browser, ...options } = devices[device]!
  const context = await browser.newContext(options)
  const master = await context.newPage(), guest = await context.newPage()
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
  await guest.getByRole('button', { name: 'Подключиться' }).tap()
  await expect(guest.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
  await guest.getByRole('button', { name: 'Я готов' }).tap()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  return { context, master, guest }
}

/** Finger tap that moves a few pixels, as on a real phone inside the horizontally scrolling players row. */
async function shakyTap(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 14, y: y + 2 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 28, y: y + 3 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

for (const device of ['iPhone 13', 'iPhone 13 landscape', 'Pixel 7', 'Pixel 7 landscape']) {
  test(`гость на телефоне: табло видно, кнопка ответа срабатывает от касания (${device})`, async ({ browser }) => {
    const { context, guest } = await joinOnPhone(browser, device)
    try {
      const board = guest.getByRole('grid', { name: 'Игровое поле' })
      await expect(board).toBeVisible({ timeout: 30_000 })
      const box = (await board.boundingBox())!
      expect(box.height).toBeGreaterThan(150)
      // The match starts scrolled to the top: the board is on screen, not above the fold.
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeLessThan(guest.viewportSize()!.height)
      await guest.getByRole('button', { name: 'Текст, 100', exact: true }).tap()
      await expect(guest.getByText('Жмите кнопку')).toBeVisible({ timeout: 15_000 })
      const buzzer = guest.getByRole('group', { name: /^Гость:/ }).locator('button.buzzer')
      await expect(buzzer).toBeEnabled()
      await buzzer.tap()
      await expect(guest.getByRole('status').filter({ hasText: 'Гость отвечает' })).toBeVisible()
    } finally { await context.close() }
  })
}

test('гость на телефоне: касание со сдвигом пальца в ряду игроков всё равно жмёт кнопку', async ({ browser }) => {
  const { context, guest } = await joinOnPhone(browser, 'Pixel 7')
  try {
    await guest.getByRole('button', { name: 'Текст, 100', exact: true }).tap()
    await expect(guest.getByText('Жмите кнопку')).toBeVisible({ timeout: 15_000 })
    const buzzer = guest.getByRole('group', { name: /^Гость:/ }).locator('button.buzzer')
    await buzzer.scrollIntoViewIfNeeded()
    const b = (await buzzer.boundingBox())!
    await shakyTap(guest, b.x + 20, b.y + b.height / 2)
    await expect(guest.getByRole('status').filter({ hasText: 'Гость отвечает' })).toBeVisible()
  } finally { await context.close() }
})
