import { expect, test, type Page } from '@playwright/test'

async function mark(page: Page, title: string): Promise<void> {
  await page.evaluate(async (text) => {
    const { pushTrace } = await import('/src/debug/trace.ts')
    pushTrace('note', text)
  }, title)
}

async function dump(page: Page): Promise<string> {
  const download = page.waitForEvent('download')
  await page.locator('.debug-copy').click()
  const file = await download
  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function storedCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const { debugLogStore } = await import('/src/debug/logDb.ts')
    await debugLogStore.flush()
    return (await debugLogStore.readAll())?.length ?? -1
  })
}

test('полный лог в IndexedDB переживает перезагрузку; новая игра и выход его стирают', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => localStorage.removeItem('aisigame.game'))
  await page.reload()
  await mark(page, 'до-игры-метка')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
  await mark(page, 'метка-до-перезагрузки')
  await storedCount(page)

  await page.reload()
  await page.getByRole('button', { name: /Продолжить прошлую игру/ }).click()
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
  const text = await dump(page)
  expect(text).toContain('log: IndexedDB')
  expect(text).toContain('метка-до-перезагрузки')
  expect(text).not.toContain('до-игры-метка')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Выход' }).click()
  await expect(page.getByRole('button', { name: 'Начать игру' })).toBeVisible()
  await expect.poll(async () => {
    const count = await storedCount(page)
    const text = await page.evaluate(async () => {
      const { debugLogStore } = await import('/src/debug/logDb.ts')
      return JSON.stringify(await debugLogStore.readAll())
    })
    return count >= 0 && !text.includes('метка-до-перезагрузки')
  }).toBe(true)
})
