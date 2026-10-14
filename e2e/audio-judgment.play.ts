import { expect, test } from '@playwright/test'

for (const mode of ['audio', 'shadow'] as const) {
  test(`${mode}: оценка, подпись, сохранение и единственное начисление`, async ({ page }) => {
    await page.goto(`/?mock=1&judge=${mode}`)
    await page.getByLabel('Пакет вопросов').selectOption('demo')
    await page.getByRole('button', { name: 'Начать игру' }).click()
    await page.getByRole('button', { name: 'Космос, 100', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
    await page.getByRole('button', { name: 'Игрок 1', exact: true }).click()
    await page.evaluate(() => {
      const controls = (window as unknown as { __aisigame: { hearAudio: (audio: string, asr: string) => void } }).__aisigame
      controls.hearAudio('Герман Титов', 'Бетельгейзе')
    })
    const heard = mode === 'audio' ? 'Герман Титов' : 'Бетельгейзе'
    const score = mode === 'audio' ? 100 : -100
    await expect(page.getByRole('group', { name: `Игрок 1: ${score}` })).toBeVisible()
    const conversation = page.getByRole('complementary', { name: 'Разговор' })
    await expect(conversation).toContainText(`Услышала: ${heard}`)
    await expect(conversation.locator('.bubble.from-player')).toHaveCount(1)
    const saved = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('aisigame.game') || '{}')))
    expect(saved).not.toMatch(/sessionGeneration|audio-judge-|committed-audio-item|apiKey/)
  })
}

test('new audio is on by default; rollback is remembered and applies to the next attempt', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  const toggle = page.getByRole('switch', { name: 'Оценивать по аудио' })
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  expect(await page.evaluate(() => localStorage.getItem('aisigame.judgmentInputMode'))).toBe('text')
  await page.reload()
  await page.getByRole('button', { name: 'Продолжить прошлую игру' }).click()
  await expect(toggle).not.toBeChecked()
  await page.getByRole('button', { name: 'Космос, 100', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
  await page.getByRole('button', { name: 'Игрок 1', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as { __aisigame: { hearAudio: (audio: string, asr: string) => void } }).__aisigame.hearAudio('Бетельгейзе', 'Герман Титов')
  })
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await toggle.check()
  expect(await page.evaluate(() => localStorage.getItem('aisigame.judgmentInputMode'))).toBe('audio')
})

test('conference master has two independent adjacent switches', async ({ page }) => {
  await page.goto('/?mock=1&transport=broadcast')
  await page.getByRole('radio', { name: 'Конференция' }).check()
  await page.getByLabel('Ваше имя').fill('Мастер')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  const controls = page.locator('.host-switches')
  const audio = controls.getByRole('switch', { name: 'Оценивать по аудио' })
  const hear = controls.getByRole('switch', { name: 'Меньше слышать' })
  await expect(audio).toBeChecked()
  await expect(hear).toBeChecked()
  await expect(controls).toHaveText(/ОПА\s*МС/)
  await expect(controls.locator('label').nth(1)).toHaveAttribute('title', /^МС — меньше слышать: /)
  await audio.uncheck()
  await hear.uncheck()
  await expect(audio).not.toBeChecked()
  await expect(hear).not.toBeChecked()
})
