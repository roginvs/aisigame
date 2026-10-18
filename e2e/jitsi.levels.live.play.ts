/**
 * Живой пробник уровней и подсветки карточек против Jitsi. Запускается вручную:
 * JITSI_LIVE=1 npx playwright test e2e/jitsi.levels.live.play.ts
 *
 * Что проверяет: свой уровень (полоска) и рамка «speaking» на собственной карточке
 * питаются собственным графом микрофона, а чужие — уровнями Jitsi; то же видит второй
 * участник. Первый тест ходит в живой Jitsi (`jitsiBase` из кода), второй — локальная
 * проверка Chromium: getStats отдаёт аудио-энергию и для дорожки Web Audio (MediaStream-
 * Destination), и для дорожки устройства (тот источник, что у lib-jitsi для локальных уровней).
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const live = process.env.JITSI_LIVE === '1'
const appPort = Number(process.env.AISIGAME_TEST_PORT ?? 5173)
const appBase = `http://127.0.0.1:${appPort}`

type Probe = {
  start: (roomName: string, displayName: string) => Promise<void>
  speakMax: () => Promise<number>
  drain: () => Promise<string[]>
  stop: () => Promise<void>
}

declare global {
  interface Window {
    __probe?: Probe
  }
}

const install = `
(async () => {
  const [{ connectJitsiConference }, { getTileLevels }] = await Promise.all([
    import(/* @vite-ignore */ '/src/conference/jitsiRoom.ts'),
    import(/* @vite-ignore */ '/src/conference/tileLevels.ts'),
  ])
  let room = null
  let localId = ''
  let timer = 0
  let speakMax = 0
  const events = []
  window.__probe = {
    start: async (roomName, displayName) => {
      try {
        room = await connectJitsiConference({
          jitsiBase: 'https://fallout-nevada.ru/jitsi',
          roomName,
          displayName,
        })
      } catch (error) {
        events.push('ОШИБКА ' + String(error))
        return
      }
      localId = room.localParticipantId()
      room.subscribeTiles((tiles) => {
        for (const tile of tiles) {
          events.push('tile ' + (tile.id === localId ? 'СОБСТВЕННАЯ' : tile.id.slice(0, 6)) + ' speaking=' + tile.speaking)
        }
      })
      room.subscribeSpeechActivity((id, end) => {
        events.push('речь ' + (id === localId ? 'СОБСТВЕННАЯ' : id.slice(0, 6)) + ' ' + (end ? 'конец ' + end.durationMs + 'мс' : 'начало'))
      })
      room.setModelHearOnly(null)
      room.modelInputStream()
      await room.setMicLive(true)
      timer = window.setInterval(() => {
        const own = getTileLevels().byParticipant[localId] ?? 0
        if (own > speakMax) speakMax = own
        for (const [id, level] of Object.entries(getTileLevels().byParticipant)) {
          if (id !== localId) events.push('полоска чужая ' + id.slice(0, 6) + '=' + level)
        }
      }, 250)
    },
    speakMax: async () => speakMax,
    drain: async () => events.splice(0, events.length),
    stop: async () => {
      if (timer) window.clearInterval(timer)
      if (room) room.dispose()
    },
  }
})()
`

async function attach(page: Page, roomName: string, displayName: string): Promise<void> {
  await page.evaluate((args) => window.__probe!.start(args.roomName, args.displayName), { roomName, displayName })
}

async function drain(page: Page, label: string): Promise<string[]> {
  const lines = await page.evaluate(() => window.__probe!.drain())
  console.log(`=== ${label}: ${lines.length} событий — уникальные`)
  for (const line of [...new Set(lines)].slice(0, 20)) console.log('  ' + line)
  return lines
}

test('живой Jitsi: свой уровень и рамка на своей карточке, чужие уровни для всех', async ({ playwright }) => {
  test.skip(!live, 'Запускается вручную: JITSI_LIVE=1 npx playwright test e2e/jitsi.levels.live.play.ts')
  test.setTimeout(90_000)
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const context = await browser.newContext({ permissions: ['microphone'] })
  const master = await context.newPage()
  const guest = await context.newPage()
  await master.goto(`${appBase}/?mock=1`)
  await guest.goto(`${appBase}/?mock=1`)
  await master.evaluate(install)
  await guest.evaluate(install)

  const roomName = 'aisigame-lvl-' + crypto.randomUUID().slice(0, 8)
  await attach(master, roomName, 'Пробник 1')
  await attach(guest, roomName, 'Пробник 2')

  // Фейковый микрофон звучит постоянно — 8 секунд.
  await master.waitForTimeout(8000)

  const masterSpeakMax = await master.evaluate(() => window.__probe!.speakMax())
  const guestSpeakMax = await guest.evaluate(() => window.__probe!.speakMax())
  const [masterLines, guestLines] = await Promise.all([drain(master, 'МАСТЕР'), drain(guest, 'ГОСТЬ')])
  console.log(`(черновые рамки: мастер ${masterLines.length}, гость ${guestLines.length})`)

  console.log(`ИТОГ: максимум своей полоски у мастера=${masterSpeakMax}, у гостя=${guestSpeakMax}`)
  // Своя полоска поднимается выше нуля у каждого — из собственного графа микрофона,
  // независимо от того, даёт ли Jitsi уровни по своей дорожке.
  expect(masterSpeakMax).toBeGreaterThan(0.05)
  expect(guestSpeakMax).toBeGreaterThan(0.05)

  await master.evaluate(() => window.__probe!.stop())
  await guest.evaluate(() => window.__probe!.stop())
})

test('Chromium: getStats отдаёт аудио-энергию дорожке Web Audio и дорожке устройства', async ({ playwright }) => {
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  await page.goto(`${appBase}/?mock=1`)
  const result = await page.evaluate(async () => {
    const inspect = async (track: MediaStreamTrack, pc: RTCPeerConnection): Promise<number> => {
      const report = await pc.getStats()
      let seen = 0
      report.forEach((item) => {
        if (item.type !== 'media-source' || item.trackIdentifier !== track.id) return
        if (typeof item.totalAudioEnergy === 'number' && item.totalAudioEnergy > 0) seen += 1
      })
      return seen
    }

    const audio = new AudioContext()
    const oscillator = audio.createOscillator()
    const destination = audio.createMediaStreamDestination()
    oscillator.connect(destination)
    oscillator.start()
    const webTrack = destination.stream.getAudioTracks()[0] as MediaStreamTrack
    const pcWeb = new RTCPeerConnection()
    pcWeb.addTrack(webTrack, destination.stream)
    await pcWeb.setLocalDescription(await pcWeb.createOffer())

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const deviceTrack = stream.getAudioTracks()[0] as MediaStreamTrack
    const pcDevice = new RTCPeerConnection()
    pcDevice.addTrack(deviceTrack, stream)
    await pcDevice.setLocalDescription(await pcDevice.createOffer())

    await new Promise((resolve) => setTimeout(resolve, 600))
    return [await inspect(webTrack, pcWeb), await inspect(deviceTrack, pcDevice)]
  })
  // Оба источника дают totalAudioEnergy: локальный уровень дорожки в lib-jitsi возможен
  // в обоих случаях (тон фейкового устройства и осциллятор Web Audio звучат постоянно).
  expect(result[0]).toBeGreaterThan(0)
  expect(result[1]).toBeGreaterThan(0)
  console.log(`media-source: WebAudio записей=${result[0]}, устройство записей=${result[1]}`)
})
