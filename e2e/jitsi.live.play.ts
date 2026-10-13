import { expect, test } from '@playwright/test'

const live = process.env.JITSI_LIVE === '1'

test('живой Jitsi передаёт раннее endpoint-сообщение после открытия BridgeChannel', async ({ page }) => {
  test.skip(!live, 'Запускается вручную: JITSI_LIVE=1 npx playwright test e2e/jitsi.live.play.ts')
  await page.goto('/?mock=1')
  const result = await page.evaluate(async () => {
    // Модуль загружается браузером через Vite; @vite-ignore оставляет абсолютный dev URL как есть.
    // @ts-expect-error Браузерный модуль не входит в граф TypeScript Playwright.
    const { connectJitsiConference } = await import(/* @vite-ignore */ '/src/conference/jitsiRoom.ts')
    const roomName = `aisigame-smoke-${crypto.randomUUID()}`
    const base = 'https://fallout-nevada.ru/jitsi'
    const first = await connectJitsiConference({
      jitsiBase: base,
      roomName,
      displayName: 'Smoke 1',
      bot: true,
    })
    const received = new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Сообщение Jitsi не пришло за 20 секунд')), 20_000)
      first.transport.subscribe((message: { type: string; name?: string }) => {
        if (message.type !== 'hello') return
        window.clearTimeout(timer)
        resolve(message.name ?? '')
      })
    })
    const second = await connectJitsiConference({
      jitsiBase: base,
      roomName,
      displayName: 'Smoke 2',
      bot: true,
    })
    // Отправляем сразу после CONFERENCE_JOINED: это тот самый порядок из полевого лога.
    second.transport.send({ type: 'hello', clientId: 'smoke-2', authToken: 'smoke-token', name: 'Smoke 2' })
    try {
      return await received
    } finally {
      second.dispose()
      first.dispose()
    }
  })

  expect(result).toBe('Smoke 2')
})

test('приложение открывает Jitsi-лобби, передаёт пакет и начинает игру', async ({ browser }) => {
  test.skip(!live, 'Запускается вручную: JITSI_LIVE=1 npx playwright test e2e/jitsi.live.play.ts')
  const context = await browser.newContext()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const master = await context.newPage()
  const joiner = await context.newPage()

  await master.goto('/')
  await master.getByLabel('Модель').selectOption('mock')
  await master.getByRole('radio', { name: 'Конференция' }).check()
  await master.getByLabel('Пакет вопросов').selectOption('demo')
  await master.getByLabel('Ваше имя').fill('Live мастер')
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(master.getByRole('button', { name: 'Начать игру' })).toBeVisible({ timeout: 45_000 })
  await master.getByRole('button', { name: 'Ссылка для игры' }).click()
  const dialog = master.getByRole('dialog', { name: 'Ссылка для игры' })
  await expect(dialog.getByRole('img', { name: 'QR-код ссылки для игры' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Скопировать ссылку' }).click()
  const invite = await master.evaluate(async () => navigator.clipboard.readText())
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  expect(new URL(invite).searchParams.get('transport')).toBeNull()

  const localInvite = new URL(invite)
  localInvite.protocol = 'http:'
  localInvite.host = new URL(master.url()).host
  await joiner.goto(localInvite.href)
  await joiner.getByLabel('Ваше имя').fill('Live игрок')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 45_000 })
  await expect(joiner.locator('.video-placeholder', { hasText: 'Live мастер' })).toBeVisible({ timeout: 30_000 })
  await expect(joiner.locator('.video-placeholder', { hasText: 'Ведущая' })).toBeVisible({ timeout: 30_000 })
  await expect(master.locator('.video-placeholder', { hasText: 'Live игрок' })).toBeVisible({ timeout: 30_000 })
  await joiner.getByRole('button', { name: 'Я готов' }).click()
  await expect(
    master
      .getByRole('listitem')
      .filter({ hasText: 'Live игрок' })
      .getByText('Пакет сверен · готов'),
  ).toBeVisible({ timeout: 30_000 })
  await master.getByRole('button', { name: 'Начать игру' }).click()

  await expect(joiner.getByRole('status').filter({ hasText: 'Live игрок выбирает вопрос' })).toBeVisible({
    timeout: 30_000,
  })
  await context.close()
})
