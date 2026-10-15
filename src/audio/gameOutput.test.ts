import { afterEach, describe, expect, it, vi } from 'vitest'

/** Минимальный AudioContext: только то, что нужно общему выходу. */
function fakeContext() {
  const links: Array<[string, string]> = []
  const node = (name: string) => ({ name, connect: (to: { name: string }) => { links.push([name, to.name]) } })
  const destination = node('destination')
  return {
    links,
    ctx: {
      state: 'running',
      destination,
      resume: () => Promise.resolve(),
      createGain: () => ({ ...node('bus'), gain: { value: 1 } }),
      createMediaStreamDestination: () => ({ ...node('stream'), stream: { id: 'bus-stream' } }),
    },
  }
}

class FakeAudioElement {
  srcObject: unknown = null
  assigned: unknown[] = []
  autoplay = false
  style = { cssText: '' }
  attrs: Record<string, string> = {}
  plays = 0
  setAttribute(key: string, value: string) { this.attrs[key] = value }
  play() { this.plays += 1; return Promise.resolve() }
}

async function load(userAgent: string) {
  vi.resetModules()
  const elements: FakeAudioElement[] = []
  const { ctx, links } = fakeContext()
  vi.stubGlobal('navigator', { userAgent })
  vi.stubGlobal('AudioContext', function AudioContext() { return ctx })
  vi.stubGlobal('document', {
    body: { append: () => undefined },
    createElement: () => {
      const element = new FakeAudioElement()
      const track = element
      let value: unknown = null
      Object.defineProperty(element, 'srcObject', { get: () => value, set: (next: unknown) => { value = next; track.assigned.push(next) } })
      elements.push(element)
      return element
    },
    addEventListener: () => undefined,
  })
  const beep = await import('./beep.ts')
  return { beep, elements, links }
}

describe('общий выход звука игры и качелька громкости на Android', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('Android распознаётся по user agent', async () => {
    const { beep } = await load('Mozilla/5.0 (Linux; Android 14; CPH2581) Chrome/129 Mobile')
    expect(beep.routesGameAudioThroughElement('Mozilla/5.0 (Linux; Android 14; OnePlus) Chrome/129')).toBe(true)
    expect(beep.routesGameAudioThroughElement('Mozilla/5.0 (X11; Linux x86_64) Chrome/129')).toBe(false)
    expect(beep.routesGameAudioThroughElement('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari')).toBe(false)
  })

  it('компьютер: выход идёт прямо в динамик контекста, без <audio>', async () => {
    const { beep, elements, links } = await load('Mozilla/5.0 (X11; Linux x86_64) Chrome/129')
    expect(beep.gameOutput()).toMatchObject({ name: 'destination' })
    expect(links).toHaveLength(0)
    expect(elements).toHaveLength(0)
  })

  it('Android: выход идёт через MediaStream в скрытый <audio>, после микрофона переподключается', async () => {
    const { beep, elements, links } = await load('Mozilla/5.0 (Linux; Android 14; CPH2581) Chrome/129 Mobile')
    const first = beep.gameOutput()
    expect(beep.gameOutput()).toBe(first)
    expect(links).toContainEqual(['bus', 'stream'])
    expect(links).not.toContainEqual(['bus', 'destination'])
    expect(elements).toHaveLength(1)
    const element = elements[0]!
    expect(element.attrs['data-game-audio']).toBe('')
    expect(element.assigned).toEqual([{ id: 'bus-stream' }])
    beep.reopenAudioOutputs()
    expect(element.assigned).toEqual([{ id: 'bus-stream' }, null, { id: 'bus-stream' }])
    expect(element.plays).toBeGreaterThanOrEqual(2)
  })
})
