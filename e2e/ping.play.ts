import { expect, test } from '@playwright/test'

test('конференция: пинг гостя виден в углу кадра у мастера и у гостя', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
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
    await expect(guest.getByRole('button', { name: 'Я готов' })).toBeEnabled()
    for (const page of [master, guest]) {
      const ping = page.getByRole('group', { name: 'Гость' }).locator('.video-ping')
      await expect(ping).toHaveText(/^\d+ ms$/, { timeout: 15_000 })
    }
    // У мастера своего пинга нет.
    await expect(master.getByRole('group', { name: 'Мастер' }).locator('.video-ping')).toHaveCount(0)
    const style = await master.getByRole('group', { name: 'Гость' }).locator('.video-ping').evaluate((node) => {
      const css = getComputedStyle(node)
      return { color: css.color, shadow: css.textShadow, position: css.position }
    })
    expect(style.color).toBe('rgb(255, 255, 255)')
    expect(style.shadow).toContain('rgb(0, 0, 0)')
    expect(style.position).toBe('absolute')
    if (process.env.PING_SCREENSHOT) await master.screenshot({ path: process.env.PING_SCREENSHOT })
  } finally { await context.close() }
})
