import { expect, test, type Page } from '@playwright/test'

/**
 * Узнаём участников по id соединения, не по имени: пары `[jitsiId, clientId]` из снимка мастера
 * (на BroadcastChannel jitsiId — id транспорта вкладки). Карточка несёт `data-jitsi-id`.
 */
test.describe('одинаковые имена и имена служебных участников', () => {
  test('два «Васи» и «Ведущая»: разные id у всех одинаково, reload меняет id только у одного', async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const master = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(master.getByRole('button', { name: 'Начать игру' })).toBeVisible()
    const invite = localInviteUrl(await copyInvite(master), master.url())

    const vasya1 = await join(context.newPage(), invite, 'Вася')
    const vasya2 = await join(context.newPage(), invite, 'Вася')
    const named = await join(context.newPage(), invite, 'Ведущая')

    // У мастера: две карточки «Вася» с разными непустыми id и карточка игрока «Ведущая».
    await expect(cards(master, 'Вася')).toHaveCount(2, { timeout: 30_000 })
    await expect(cards(master, 'Ведущая')).toHaveCount(1)
    const masterIds = await idsOf(master, 'Вася')
    expect(masterIds.every(Boolean)).toBe(true)
    expect(new Set(masterIds).size).toBe(2)
    const namedId = await cards(master, 'Ведущая').getAttribute('data-jitsi-id')
    expect(namedId).toBeTruthy()
    expect(masterIds).not.toContain(namedId)

    // У игроков то же самое (общий полученный снимок): чужой «Вася» с тем же id, что у мастера.
    await expect.poll(() => idsOf(named, 'Вася').then((ids) => ids.sort()), { timeout: 15_000 }).toEqual([...masterIds].sort())
    await expect.poll(() => cards(vasya2, 'Ведущая').getAttribute('data-jitsi-id'), { timeout: 15_000 }).toBe(namedId)
    const otherOnVasya1 = (await idsOf(vasya1, 'Вася')).filter(Boolean)
    expect(otherOnVasya1.length).toBeGreaterThanOrEqual(1)
    for (const id of otherOnVasya1) expect(masterIds).toContain(id)
    await expect(vasya1.locator('.conference-player.self')).toHaveCount(1)
    await expect(named.locator('.conference-player.self')).toHaveAttribute('aria-label', /Ведущая/)

    // Reload первого «Васи»: новый id соединения, у второго прежний, карточек по-прежнему две.
    await vasya1.reload()
    // Имя для поля входа общее на браузер (последнее введённое — «Ведущая»), вводим заново.
    await vasya1.getByLabel('Ваше имя').fill('Вася')
    await vasya1.getByRole('button', { name: 'Подключиться' }).click()
    await expect.poll(async () => {
      const ids = await idsOf(master, 'Вася')
      return ids.length === 2 && ids.every(Boolean) && new Set(ids).size === 2 && ids.filter((id) => masterIds.includes(id)).length === 1
    }, { timeout: 30_000 }).toBe(true)
    const after = await idsOf(master, 'Вася')
    expect(after.filter((id) => !masterIds.includes(id))).toHaveLength(1)
    await expect.poll(() => idsOf(named, 'Вася').then((ids) => ids.sort()), { timeout: 15_000 }).toEqual([...after].sort())
    await context.close()
  })

  test('партия с двумя «Васями»: в игре карточки тоже по id, своя карточка у каждого своя', async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const master = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    const invite = localInviteUrl(await copyInvite(master), master.url())
    const guests = [await join(context.newPage(), invite, 'Вася'), await join(context.newPage(), invite, 'Вася')]
    for (const guest of guests) {
      await expect(guest.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
      await guest.getByRole('button', { name: 'Я в игре' }).click()
    }
    await expect(master.getByText('Пакет сверен · готов')).toHaveCount(2, { timeout: 30_000 })
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await expect(master.locator('.conference-player').first()).toBeVisible()
    await expect.poll(async () => {
      const ids = await idsOf(master, 'Вася')
      return ids.length === 2 && ids.every(Boolean) && new Set(ids).size === 2
    }, { timeout: 30_000 }).toBe(true)
    const masterIds = await idsOf(master, 'Вася')
    for (const guest of guests) {
      // Свою карточку игрок видит как свою (локальная камера), чужого «Васю» — с id из снимка.
      await expect(guest.locator('.conference-player.self')).toHaveCount(1)
      await expect.poll(async () => (await idsOf(guest, 'Вася')).filter(Boolean).length).toBeGreaterThanOrEqual(1)
      for (const id of (await idsOf(guest, 'Вася')).filter(Boolean)) expect(masterIds).toContain(id)
    }
    await context.close()
  })
})

function cards(page: Page, name: string) {
  return page.locator(`.conference-player[role="group"][aria-label="${name}"], .conference-player[role="group"][aria-label^="${name}: "]`)
}

async function idsOf(page: Page, name: string): Promise<string[]> {
  return cards(page, name).evaluateAll((items) => items.map((item) => item.getAttribute('data-jitsi-id') ?? ''))
}

async function join(pending: Promise<Page>, invite: string, name: string): Promise<Page> {
  const page = await pending
  await page.goto(invite.includes('mock=1') ? invite : `${invite}&mock=1`)
  await page.getByLabel('Ваше имя').fill(name)
  await page.getByRole('button', { name: 'Подключиться' }).click()
  await expect(page.getByRole('button', { name: 'Я в игре' })).toBeVisible({ timeout: 60_000 })
  return page
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
