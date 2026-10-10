import { expect, test, type Page } from '@playwright/test'

test('выход стирает партию, обновление страницы её продолжает', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => localStorage.removeItem('aisigame.game'))
  await page.reload()

  const continueButton = page.getByRole('button', { name: 'Продолжить прошлую игру' })
  await expect(continueButton).toBeVisible()
  await expect(continueButton).toBeDisabled()

  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.locator('.talk .host .host-line')).toHaveText('назовите тему и стоимость')
  await expect(page.getByRole('button', { name: 'Остановить' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
  const started = await readGame(page)
  expect(started.packId).toBeTruthy()
  expect(started.phase).not.toBe('stopped')
  expect(JSON.stringify(started)).not.toMatch(/apiKey|openaiApiKey|sk-/)

  await expect(page.getByRole('button', { name: 'Выход' })).toBeVisible()
  await page.getByRole('button', { name: 'Выход' }).click()
  await expect(page.getByRole('button', { name: 'Начать игру' })).toBeVisible()
  await expect(continueButton).toBeVisible()
  await expect(continueButton).toBeDisabled()
  expect(await page.evaluate(() => localStorage.getItem('aisigame.game'))).toBeNull()

  await page.getByLabel('Пакет вопросов').selectOption('tournament')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.locator('.talk .host')).toContainText('назовите тему и стоимость')
  await page.getByRole('button', { name: '100' }).first().click()
  await expect(page.getByRole('heading', { name: 'В какое море впадает Волга?' })).toBeVisible()
  await page.getByRole('button', { name: 'Игрок 2', exact: true }).click()
  await hear(page, 'Каспийское')
  await expect(page.locator('.player', { hasText: 'Игрок 2' })).toContainText('100')
  await page.getByRole('button', { name: 'Пропустить раунд' }).click()
  await expect(page.locator('.eyebrow').first()).toContainText('Второй раунд')

  const mid = await readGame(page)
  expect(mid.packId).toBe('tournament')
  expect(mid.roundIndex).toBeGreaterThan(0)
  expect(mid.players.find((player) => player.id === 2)?.score).toBe(100)

  await page.reload()
  await expect(continueButton).toBeEnabled()
  await continueButton.click()
  await expect(page.locator('.eyebrow').first()).toContainText('Второй раунд')
  await expect(page.locator('.player', { hasText: 'Игрок 2' })).toContainText('100')
  await expect(page.locator('.player', { hasText: 'Игрок 1' })).toContainText('0')
})

test('пакет с диска продолжается повторным выбором файла', async ({ page }) => {
  const saved = diskSnapshot()
  await page.goto('/?mock=1')
  await page.evaluate((game) => {
    localStorage.setItem('aisigame.openaiApiKey', 'sk-test-disk-resume')
    localStorage.setItem('aisigame.game', JSON.stringify(game))
  }, saved)
  await page.reload()

  const continueButton = page.getByRole('button', { name: 'Продолжить прошлую игру' })
  await expect(continueButton).toBeEnabled()
  await expect(page.getByText('Пак «чиллово-кнопочный #3»')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Начать игру' })).toBeEnabled()
  const beforePick = await page.evaluate(() => localStorage.getItem('aisigame.game'))

  const brokenChooser = page.waitForEvent('filechooser')
  await continueButton.click()
  const broken = await brokenChooser
  expect(await page.evaluate(() => localStorage.getItem('aisigame.game'))).toBe(beforePick)
  await broken.setFiles({
    name: 'broken.siq',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('this is not a package'),
  })
  await expect(page.locator('.start .error')).toContainText('Не удалось открыть файл')
  await expect(page.getByRole('button', { name: 'Начать игру' })).toBeVisible()
  await expect(continueButton).toBeEnabled()
  const afterError = await readGame(page)
  expect(afterError.packId).toBe('file')
  expect(afterError.players.find((player) => player.id === 1)?.score).toBe(250)
  expect(JSON.stringify(afterError)).not.toContain('sk-test-disk-resume')
  expect(await page.evaluate(() => localStorage.getItem('aisigame.openaiApiKey'))).toBe('sk-test-disk-resume')

  const resumeChooser = page.waitForEvent('filechooser')
  await continueButton.click()
  const resume = await resumeChooser
  await resume.setFiles({
    name: 'other-pack.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(diskPackXml),
  })
  await expect(page.locator('.eyebrow').first()).toContainText('С диска')
  await expect(page.locator('.eyebrow').first()).toContainText('Раунд с диска')
  await expect(page.locator('.talk .host')).toContainText('назовите тему и стоимость')
  await expect(page.locator('.player', { hasText: 'Игрок 1' })).toContainText('250')
  await expect(page.locator('.player', { hasText: 'Игрок 2' })).toContainText('-30')
  await expect(page.locator('.player', { hasText: 'Игрок 3' })).toContainText('40')
  await expect(page.locator('.player', { hasText: 'Игрок 3' }).getByRole('button')).toHaveText('выбирайте вопрос')
  await expect(page.locator('.theme-row', { hasText: 'Реки' }).getByRole('button', { name: /сыграно/ })).toBeDisabled()
  await expect(page.locator('.theme-row', { hasText: 'Реки' }).getByRole('button', { name: '200' })).toBeEnabled()

  const resumed = await readGame(page)
  expect(resumed.packId).toBe('file')
  expect(resumed.phase).toBe('choosing.listening')
  expect(resumed.roundIndex).toBe(0)
  expect(resumed.players.find((player) => player.id === 1)?.score).toBe(250)
  expect(JSON.stringify(resumed)).not.toMatch(/apiKey|openaiApiKey|sk-/)

  await page.getByRole('button', { name: 'Выход' }).click()
  await expect(page.getByRole('button', { name: 'Начать игру' })).toBeVisible()
  await expect(continueButton).toBeDisabled()
  expect(await page.evaluate(() => localStorage.getItem('aisigame.game'))).toBeNull()
})

const diskPackXml = `<?xml version="1.0" encoding="utf-8"?>
<package name="С диска">
  <rounds>
    <round name="Раунд с диска">
      <themes>
        <theme name="Реки">
          <questions>
            <question price="100"><params><param name="question" type="content"><item>Куда впадает Волга?</item></param></params><right><answer>Каспийское</answer></right></question>
            <question price="200"><params><param name="question" type="content"><item>Какая река самая длинная?</item></param></params><right><answer>Нил</answer></right></question>
          </questions>
        </theme>
      </themes>
    </round>
  </rounds>
</package>`

function diskSnapshot() {
  return {
    version: 1,
    packId: 'file',
    packFile: 'chill.siq',
    packName: 'чиллово-кнопочный #3',
    players: [
      { id: 1, name: 'Игрок 1', score: 250 },
      { id: 2, name: 'Игрок 2', score: -30 },
      { id: 3, name: 'Игрок 3', score: 40 },
    ],
    roundIndex: 0,
    playedIds: ['r0-t0-100-0'],
    missedIds: [],
    chooserId: 3,
    finalists: [],
    bets: [],
    finalCursor: 0,
    betMisses: 0,
    activeQuestionId: null,
    activePlayerId: null,
    activeStake: null,
    attemptId: 0,
    clarifications: 0,
    heard: '',
    announceKind: null,
    judgmentStatus: null,
    phase: 'choosing.listening',
  }
}

async function readGame(page: Page): Promise<{
  packId: string
  phase: string
  roundIndex: number
  players: Array<{ id: number; score: number }>
}> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('aisigame.game')
    if (!raw) throw new Error('нет снимка партии')
    return JSON.parse(raw) as {
      packId: string
      phase: string
      roundIndex: number
      players: Array<{ id: number; score: number }>
    }
  })
}

async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } })
      .__aisigame
    if (!controls) throw new Error('нет заглушки ведущей')
    controls.hear(line, 1400)
  }, text)
}
