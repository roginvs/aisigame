import { expect, test, type Page } from '@playwright/test'

test.describe('конференция на BroadcastChannel', () => {
  test('лобби мастера можно продолжить после обновления страницы', async ({ page }) => {
    await page.goto('/?mock=1&transport=broadcast')
    await page.evaluate(() => localStorage.removeItem('aisigame.game'))
    await page.reload()
    await page.getByLabel('Модель').selectOption('mock')
    await page.getByRole('radio', { name: 'Конференция' }).check()
    await page.getByLabel('Пакет вопросов').selectOption('demo')
    await page.getByLabel('Ваше имя').fill('Мастер')
    await page.getByRole('button', { name: 'Начать игру' }).click()
    await expect(page.getByRole('button', { name: 'Ссылка для игры' })).toBeVisible()

    const before = await page.evaluate(() => {
      const raw = localStorage.getItem('aisigame.game')
      if (!raw) throw new Error('нет сохранения лобби')
      return JSON.parse(raw) as { mode?: string; conferenceLobby?: boolean; roomId?: string }
    })
    expect(before).toMatchObject({ mode: 'conference', conferenceLobby: true })
    expect(before.roomId).toBeTruthy()

    await page.reload()
    const continueButton = page.getByRole('button', { name: /Продолжить прошлую игру/ })
    await expect(continueButton).toBeEnabled()
    await expect(continueButton).toContainText('Онлайн · Демо')
    await expect(continueButton).not.toContainText('Прошлая игра:')
    await continueButton.click()
    await expect(page.getByRole('button', { name: 'Ссылка для игры' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Начать игру' })).toBeVisible()

    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('aisigame.game') ?? 'null'))
    expect(after).toMatchObject({ mode: 'conference', conferenceLobby: true, roomId: before.roomId })
  })

  test('верный ответ joiner меняет счёт у мастера', async ({ browser }) => {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const master = await context.newPage()
    const joiner = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(master.getByRole('button', { name: 'Начать игру' })).toBeVisible()

    await master.getByRole('button', { name: 'Ссылка для игры' }).click()
    const dialog = master.getByRole('dialog', { name: 'Ссылка для игры' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('img', { name: 'QR-код ссылки для игры' })).toBeVisible()
    const publicLink = dialog.getByLabel('Ссылка для игроков')
    await expect(publicLink).toHaveValue(/^https:\/\/dev\.fallout-nevada\.ru\//)
    const copyButton = dialog.locator('.invite-copy')
    const copyWidth = (await copyButton.boundingBox())?.width
    await dialog.getByRole('button', { name: 'Скопировать ссылку' }).click()
    await expect(copyButton).toHaveAccessibleName('Скопировано')
    expect((await copyButton.boundingBox())?.width).toBe(copyWidth)
    const invite = await master.evaluate(async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    })
    expect(invite).toContain('join=')
    await expect(copyButton).toHaveAccessibleName('Скопировать ссылку', { timeout: 3_000 })
    expect((await copyButton.boundingBox())?.width).toBe(copyWidth)
    await dialog.getByRole('button', { name: 'Закрыть' }).click()
    const localInvite = localInviteUrl(invite)
    const joinerUrl = localInvite.includes('mock=1')
      ? localInvite
      : `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await expect(joiner.getByRole('button', { name: 'Подключиться' })).toBeVisible()
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeVisible()
    await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
    await joiner.getByRole('button', { name: 'Я готов' }).click()
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(joiner.getByRole('status').filter({ hasText: 'Гость выбирает вопрос' })).toBeVisible({
      timeout: 30_000,
    })

    const masterCell = master.getByRole('button', { name: 'Текст, 100' })
    const joinerCell = joiner.getByRole('button', { name: 'Текст, 100' })
    await expect(masterCell).toBeDisabled()
    await expect(joinerCell).toBeEnabled()
    await joinerCell.click()
    await expect(joiner.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 20_000 })
    await expect(master.getByRole('group', { name: /Мастер: 0/ }).getByRole('button', { name: 'Мастер' })).toBeEnabled()
    await expect(master.getByRole('group', { name: /Гость: 0/ }).getByRole('button', { name: 'Гость' })).toBeDisabled()
    await expect(joiner.getByRole('group', { name: /Мастер: 0/ }).getByRole('button', { name: 'Мастер' })).toBeDisabled()
    await expect(joiner.getByRole('group', { name: /Гость: 0/ }).getByRole('button', { name: 'Гость' })).toBeEnabled()
    await joiner.getByRole('button', { name: 'Гость' }).click()
    await hear(master, 'август')
    await expect(master.getByRole('group', { name: /Гость: 100/ })).toBeVisible({ timeout: 20_000 })

    await expect(joiner.getByRole('button', { name: 'Текст, 200' })).toBeEnabled({ timeout: 10_000 })
    await joiner.getByRole('button', { name: 'Текст, 200' }).click()
    await expect(master.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 20_000 })
    await master.getByRole('group', { name: /Мастер: 0/ }).getByRole('button', { name: 'Мастер' }).click()
    await expect(joiner.getByRole('status').filter({ hasText: 'Мастер отвечает' })).toBeVisible()
    const mutedReminder = master.getByText(/Мастер,.+микрофон/i)
    await master.waitForTimeout(2_500)
    await expect(mutedReminder).toHaveCount(0)
    await expect(mutedReminder).toBeVisible({ timeout: 2_000 })
    await hear(master, 'кислород')
    await expect(joiner.getByRole('status').filter({ hasText: 'Мастер выбирает вопрос' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(joiner.getByRole('status').filter({ hasText: 'Не говорите' })).toHaveCount(0)
  })

  test('мастер продолжает ту же комнату, а вернувшийся clientId сохраняет счёт', async ({ browser }) => {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const master = await context.newPage()
    const joiner = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    const invite = await copyInvite(master)
    const roomId = new URL(invite).searchParams.get('join')
    expect(roomId).toBeTruthy()

    const localInvite = localInviteUrl(invite)
    const joinerUrl = `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
    await joiner.getByRole('button', { name: 'Я готов' }).click()
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(joiner.getByRole('status').filter({ hasText: 'Гость выбирает вопрос' })).toBeVisible({
      timeout: 30_000,
    })

    const savedBefore = await master.evaluate(() => {
      const raw = localStorage.getItem('aisigame.game')
      if (!raw) throw new Error('нет сохранения конференции')
      const saved = JSON.parse(raw) as {
        roomId?: string
        phase: string
        players: Array<{ id: number; name: string; score: number; clientId?: string }>
      }
      const guest = saved.players.find((player) => player.name === 'Гость')
      if (!guest?.clientId) throw new Error('у гостя не сохранён clientId')
      guest.score = 300
      saved.phase = 'choosing.listening'
      localStorage.setItem('aisigame.game', JSON.stringify(saved))
      return { roomId: saved.roomId, guestClientId: guest.clientId, guestId: guest.id }
    })
    expect(savedBefore.roomId).toBe(roomId)

    await master.reload()
    await master.getByRole('button', { name: 'Продолжить прошлую игру' }).click()
    await expect(master.getByRole('status').filter({ hasText: 'Гость выбирает вопрос' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(master.getByRole('group', { name: /Гость: 300/ })).toBeVisible()
    await expect(joiner.getByRole('group', { name: /Гость: 300/ })).toBeVisible({ timeout: 30_000 })

    const savedAfter = await master.evaluate(() => {
      const raw = localStorage.getItem('aisigame.game')
      return raw ? JSON.parse(raw) : null
    })
    expect(savedAfter.roomId).toBe(roomId)
    expect(savedAfter.players.find((player: { clientId?: string }) => player.clientId === savedBefore.guestClientId)).toMatchObject({
      id: savedBefore.guestId,
      score: 300,
    })

    const masterCell = master.getByRole('button', { name: 'Текст, 100' })
    const joinerCell = joiner.getByRole('button', { name: 'Текст, 100' })
    await expect(masterCell).toBeDisabled()
    await expect(joinerCell).toBeEnabled()
    await joinerCell.click()
    await expect(joiner.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 20_000 })
    await joiner.getByRole('button', { name: 'Гость' }).click()
    await hear(master, 'август')
    await expect(master.getByRole('group', { name: /Гость: 400/ })).toBeVisible({ timeout: 20_000 })
  })

  test('Не входить оставляет меню', async ({ page }) => {
    const room = '00000000-0000-4000-8000-000000000001'
    const jitsi = encodeURIComponent('https://fallout-nevada.ru/jitsi')
    await page.goto(`/?join=${room}&jitsi=${jitsi}`)
    await page.getByRole('button', { name: 'Не входить' }).click()
    await expect(page.getByRole('button', { name: 'Начать игру' })).toBeVisible()
    await expect(page).not.toHaveURL(/join=/)
  })

  test('подменённый байт пакета держит «Я готов» выключенной', async ({ browser }) => {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const master = await context.newPage()
    const joiner = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    const invite = await copyInvite(master)
    const localInvite = localInviteUrl(invite)
    const joinerUrl = `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.evaluate(() => sessionStorage.setItem('aisigame.tamperPack', '1'))
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeDisabled({ timeout: 60_000 })
  })

  test('в лобби у гостя виден статус загрузки/готовности, не обрезан рядом игроков', async ({ browser }) => {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const master = await context.newPage()
    const joiner = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(master.getByRole('button', { name: 'Начать игру' })).toBeVisible()

    const invite = await copyInvite(master)
    const localInvite = localInviteUrl(invite)
    const joinerUrl = localInvite.includes('mock=1')
      ? localInvite
      : `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })

    const guestProgress = master.locator('.conference-player .player-lobby-progress').filter({ hasText: /Пакет|Загрузка/ })
    await expect(guestProgress.first()).toBeVisible({ timeout: 30_000 })
    const box = await guestProgress.first().boundingBox()
    expect(box?.height ?? 0).toBeGreaterThan(8)

    await joiner.getByRole('button', { name: 'Я готов' }).click()
    await expect(master.getByText('Пакет сверен · готов')).toBeVisible({ timeout: 15_000 })
  })
})

async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } })
      .__aisigame
    if (!controls) throw new Error('нет заглушки ведущей')
    controls.hear(line, 1400)
  }, text)
}

async function copyInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Ссылка для игры' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ссылка для игры' })
  await expect(dialog.getByRole('img', { name: 'QR-код ссылки для игры' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Скопировать ссылку' }).click()
  const invite = await page.evaluate(async () => navigator.clipboard.readText())
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  return invite
}

function localInviteUrl(invite: string): string {
  const url = new URL(invite)
  url.protocol = 'http:'
  url.host = '127.0.0.1:5173'
  return url.href
}
