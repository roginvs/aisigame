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

    await expect(page.locator('.chat-log')).toContainText('Игра создана. Ждём игроков.', { timeout: 15_000 })
    await page.getByRole('textbox').fill('Чат в сохранённом лобби')
    await page.getByRole('textbox').press('Enter')
    await expect(page.locator('.chat-log')).toContainText('Чат в сохранённом лобби')
    const history = await readHistory(page)
    expect(Object.keys(history)).toHaveLength(201)

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
    await expect(page.locator('.chat-log')).toContainText('Игра создана. Ждём игроков.', { timeout: 15_000 })
    await expect(page.locator('.chat-log')).toContainText('Чат в сохранённом лобби')
    expect(await readHistory(page)).toEqual(history)
  })

  test('игрок после reload сверяет кеш по глобальному хешу или скачивает пакет заново', async ({ browser }) => {
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
    const invite = localInviteUrl(await copyInvite(master), master.url())
    await joiner.goto(`${invite}&mock=1`)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled()
    await master.getByRole('textbox').fill('Сообщение до перезагрузки')
    await master.getByRole('textbox').press('Enter')
    const guestAtMaster = master.getByRole('group', { name: 'Гость', exact: true })
    for (const clearCache of [false, true]) {
      await joiner.getByRole('button', { name: 'Я в игре' }).click()
      await expect(guestAtMaster.getByText('Пакет сверен · готов', { exact: true })).toBeVisible()
      if (clearCache) {
        await joiner.evaluate(() => new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase('aisigame.packs')
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () => reject(new Error('кеш пакета занят'))
        }))
      }
      await joiner.reload()
      await joiner.getByRole('button', { name: 'Подключиться' }).click()
      await expect(joiner.locator('.bubble-typed').filter({ hasText: 'Сообщение до перезагрузки' })).toBeVisible()
      await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled()
      await expect(joiner.getByRole('group', { name: 'Гость', exact: true }).getByText('Пакет сверен', { exact: true })).toBeVisible()
      await expect(guestAtMaster.getByText('Пакет сверен', { exact: true })).toBeVisible()
      await expect(guestAtMaster.getByText('Пакет сверен · готов', { exact: true })).toHaveCount(0)
    }
    await context.close()
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
    const masterOrigin = new URL(master.url()).origin
    expect(new URL(await publicLink.inputValue()).origin).toBe(
      masterOrigin === 'http://127.0.0.1:5173' ? 'https://dev.fallout-nevada.ru' : masterOrigin,
    )
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
    const localInvite = localInviteUrl(invite, master.url())
    const joinerUrl = localInvite.includes('mock=1')
      ? localInvite
      : `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await expect(joiner.getByRole('button', { name: 'Подключиться' })).toBeVisible()
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeVisible()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
    await joiner.getByRole('button', { name: 'Я в игре' }).click()
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
    await expect(master.getByRole('group', { name: /Мастер: 0/ }).getByRole('button', { name: 'Жмите' })).toBeEnabled()
    await expect(master.getByRole('group', { name: /Гость: 0/ }).getByRole('button', { name: 'Жмите' })).toBeDisabled()
    await expect(joiner.getByRole('group', { name: /Мастер: 0/ }).getByRole('button', { name: 'Жмите' })).toBeDisabled()
    await expect(joiner.getByRole('group', { name: /Гость: 0/ }).getByRole('button', { name: 'Жмите' })).toBeEnabled()
    await joiner.getByRole('group', { name: /Гость:/ }).getByRole('button', { name: 'Жмите' }).click()
    await hear(master, 'август')
    await expect(master.getByRole('group', { name: /Гость: 100/ })).toBeVisible({ timeout: 20_000 })

    await expect(master.locator('.chat-log')).toContainText('Правильный ответ:')
    await expect(joiner.getByRole('button', { name: 'Текст, 200' })).toBeEnabled({ timeout: 10_000 })
    const history = await readHistory(master)
    await master.reload()
    await master.getByRole('button', { name: 'Продолжить прошлую игру' }).click()
    await expect(master.getByRole('group', { name: /Гость: 100/ })).toBeVisible()
    await expect(master.locator('.chat-log')).toContainText('Правильный ответ:')
    await expect(joiner.locator('.chat-log')).toContainText('Правильный ответ:')
    expect(await readHistory(master)).toEqual(history)

    await expect(joiner.getByRole('button', { name: 'Текст, 200' })).toBeEnabled({ timeout: 10_000 })
    await joiner.getByRole('button', { name: 'Текст, 200' }).click()
    await expect(master.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 20_000 })
    await master.getByRole('group', { name: /Мастер: 0/ }).getByRole('button', { name: 'Жмите' }).click()
    await expect(joiner.getByRole('status').filter({ hasText: 'Мастер отвечает' })).toBeVisible()
    const mutedReminder = master.getByText(/Мастер,.+микрофон/i)
    // Сначала короткое обращение по имени после кнопки, напоминание про микрофон — позже, отдельной репликой.
    await expect(master.getByRole('complementary', { name: 'Разговор' }).getByText('Мастер, ваш ответ.')).toBeVisible()
    await expect(mutedReminder).toBeVisible({ timeout: 6_000 })
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

    const localInvite = localInviteUrl(invite, master.url())
    const joinerUrl = `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
    await joiner.getByRole('button', { name: 'Я в игре' }).click()
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
    await joiner.getByRole('group', { name: /Гость:/ }).getByRole('button', { name: 'Жмите' }).click()
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

  test('подменённый байт пакета держит «Я в игре» выключенной', async ({ browser }) => {
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
    const localInvite = localInviteUrl(invite, master.url())
    const joinerUrl = `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.evaluate(() => sessionStorage.setItem('aisigame.tamperPack', '1'))
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeDisabled({ timeout: 60_000 })
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
    const localInvite = localInviteUrl(invite, master.url())
    const joinerUrl = localInvite.includes('mock=1')
      ? localInvite
      : `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })

    const guestProgress = master.locator('.conference-player .player-lobby-progress').filter({ hasText: /Пакет|Загрузка/ })
    await expect(guestProgress.first()).toBeVisible({ timeout: 30_000 })
    const box = await guestProgress.first().boundingBox()
    expect(box?.height ?? 0).toBeGreaterThan(8)

    await joiner.getByRole('button', { name: 'Я в игре' }).click()
    await expect(master.getByText('Пакет сверен · готов')).toBeVisible({ timeout: 15_000 })
  })

  test('пауза в лобби: ставят и снимают все, оверлей у мастера и гостя, старт после паузы', async ({ browser }) => {
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
    const localInvite = localInviteUrl(invite, master.url())
    const joinerUrl = localInvite.includes('mock=1')
      ? localInvite
      : `${localInvite}${localInvite.includes('?') ? '&' : '?'}mock=1`
    await joiner.goto(joinerUrl)
    await joiner.getByLabel('Ваше имя').fill('Гость')
    await joiner.getByRole('button', { name: 'Подключиться' }).click()
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })

    // Гость ставит паузу — «Пауза» видна обоим, кнопки переключаются на «Дальше».
    await joiner.getByRole('button', { name: 'Пауза', exact: true }).click()
    await expect(joiner.locator('.stage-pause')).toContainText('Пауза')
    await expect(master.locator('.stage-pause')).toContainText('Пауза')
    await expect(master.getByRole('button', { name: 'Дальше' })).toBeVisible()
    await expect(joiner.getByRole('button', { name: 'Дальше' })).toBeVisible()

    // Мастер снимает — лобби возвращается у обоих.
    await master.getByRole('button', { name: 'Дальше' }).click()
    await expect(master.locator('.stage-pause')).toHaveCount(0)
    await expect(joiner.locator('.stage-pause')).toHaveCount(0)
    await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled()

    // Партия стартует после паузы как обычно.
    await joiner.getByRole('button', { name: 'Я в игре' }).click()
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(master.locator('.board')).toBeVisible({ timeout: 30_000 })
    await expect(joiner.locator('.stage-pause')).toHaveCount(0)
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

function localInviteUrl(invite: string, masterUrl: string): string {
  const url = new URL(invite)
  const master = new URL(masterUrl)
  url.protocol = master.protocol
  url.host = master.host
  return url.href
}

async function readHistory(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('aisigame.game') ?? 'null')
    if (!saved) throw new Error('нет сохранённой истории')
    if ('chat' in saved || 'conversation' in saved) throw new Error('история всё ещё хранится отдельными массивами')
    return Object.fromEntries(Object.entries(saved).filter(([key]) => /^message(?:Index|\d+)$/.test(key)))
  })
}
