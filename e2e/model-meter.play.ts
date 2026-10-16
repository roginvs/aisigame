import { expect, test } from '@playwright/test'

test('мастер конференции видит индикатор того, что слышит модель;', async ({ page }) => {
  await page.goto('/?mock=1&transport=broadcast')
  await page.evaluate(() => localStorage.removeItem('aisigame.game'))
  await page.reload()
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByRole('radio', { name: 'Конференция' }).check()
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByLabel('Ваше имя').fill('Мастер')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  const meter = page.getByTestId('model-meter')
  await expect(meter).toBeVisible()
  await expect(meter).toHaveAttribute('width', '320')
  await expect(meter).toHaveAttribute('height', '20')
  const legend = page.getByTestId('model-meter-legend')
  await expect(legend).toBeHidden()
  await meter.hover()
  await expect(legend).toBeVisible()
  await expect(legend).toContainText('ушёл в модель')
  await expect(legend).toContainText('вход модели закрыт')
  for (const group of ['hostStart', 'vadStart', 'response', 'reading', 'buzzing', 'answering', 'choosing', 'special', 'appeal', 'phase', 'buzzer', 'hostEnd', 'vadStop', 'responseEnd', 'transcript', 'mixer', 'cancel']) {
    await expect(legend.locator(`[data-group="${group}"] .sw`)).toHaveCount(1)
  }
  // Подписи конкретных объектов: подложим полосу речи игрока и черту кнопки.
  await page.mouse.move(0, 500)
  await page.evaluate(async () => {
    const push = window.__aisigameTrace!
    push('in', 'input_audio_buffer.speech_started')
    await new Promise((r) => setTimeout(r, 1800))
    push('in', 'input_audio_buffer.speech_stopped')
    await new Promise((r) => setTimeout(r, 600))
    push('in', 'conversation.item.input_audio_transcription.completed')
    await new Promise((r) => setTimeout(r, 200))
  })
  const box = (await meter.boundingBox())!
  const tip = page.getByTestId('model-meter-tip')
  // Наведение замораживает картинку — ищем объект, проводя мышью справа налево.
  await page.mouse.move(box.x + box.width - 2, box.y + 10)
  const findTip = async (y: number, re: RegExp) => {
    for (let x = box.width - 2; x > 1; x -= 1) {
      await page.mouse.move(box.x + x, box.y + y)
      const text = (await tip.count()) ? await tip.innerText() : ''
      if (re.test(text)) return true
    }
    return false
  }
  expect(await findTip(5, /^Речь игрока \(VAD\), [12],\d с$/)).toBe(true)
  await expect(legend).toBeHidden()
  if (process.env.METER_TITLE_BAR_SHOT) await page.screenshot({ path: process.env.METER_TITLE_BAR_SHOT, clip: { x: 0, y: 0, width: 700, height: 160 } })
  expect(await findTip(17, /^Расшифровка готова, \d\d:\d\d:\d\d$/)).toBe(true)
  if (process.env.METER_TITLE_LINE_SHOT) await page.screenshot({ path: process.env.METER_TITLE_LINE_SHOT, clip: { x: 0, y: 0, width: 700, height: 160 } })
  await page.mouse.move(box.x + 2, box.y + 17)
  await expect(tip).toBeHidden()
  await expect(legend).toBeVisible()
  if (process.env.MODEL_METER_HOVER_SHOT) await page.screenshot({ path: process.env.MODEL_METER_HOVER_SHOT, clip: { x: 0, y: 0, width: 900, height: 420 } })
  if (process.env.MODEL_METER_SHOT) {
    await page.locator('header.topbar').screenshot({ path: process.env.MODEL_METER_SHOT })
  }
})
