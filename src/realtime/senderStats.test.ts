import { describe, expect, it } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { noteModelSenderStats, summarizeAudioSender, type ModelSenderStats } from './senderStats.ts'

function reports(items: object[]) {
  return {
    forEach(callback: (report: object) => void) {
      for (const item of items) callback(item)
    },
  }
}

function sender(items: object[] | 'fail', kind = 'audio') {
  return {
    track: { kind },
    getStats: () => (items === 'fail' ? Promise.reject(new Error('stats')) : Promise.resolve(reports(items))),
  }
}

describe('summarizeAudioSender', () => {
  it('берёт исходящий звук и встречный отчёт, видео пропускает', async () => {
    const stats = await summarizeAudioSender({
      getSenders: () => [
        sender([{ type: 'outbound-rtp', kind: 'video', packetsSent: 9, bytesSent: 9 }], 'video'),
        sender([
          { type: 'outbound-rtp', kind: 'audio', packetsSent: 12, bytesSent: 3400 },
          { type: 'remote-inbound-rtp', mediaType: 'audio', packetsLost: 2, jitter: 0.01, roundTripTime: 0.04 },
          { type: 'candidate-pair', kind: 'audio', packetsSent: 99 },
        ]),
      ],
    })
    expect(stats).toEqual({
      packetsSent: 12,
      bytesSent: 3400,
      packetsLost: 2,
      jitter: 0.01,
      roundTripTime: 0.04,
    })
  })

  it('нет аудио-отправителя, пустой отчёт и сбой getStats — null', async () => {
    expect(await summarizeAudioSender({ getSenders: () => [] })).toBeNull()
    expect(await summarizeAudioSender({ getSenders: () => [sender([])] })).toBeNull()
    expect(await summarizeAudioSender({ getSenders: () => [sender('fail')] })).toBeNull()
    expect(await summarizeAudioSender({
      getSenders: () => [sender([{ type: 'outbound-rtp', kind: 'audio', packetsSent: Number.NaN }])],
    })).toEqual({ packetsSent: null, bytesSent: null, packetsLost: null, jitter: null, roundTripTime: null })
  })
})

describe('noteModelSenderStats', () => {
  it('пишет одну строку, если снимок есть, и молчит на пустом снимке и ошибке', async () => {
    const mark = getTrace().at(-1)?.id ?? 0
    const snapshot: ModelSenderStats = {
      packetsSent: 3, bytesSent: 100, packetsLost: 1, jitter: 0.02, roundTripTime: null,
    }
    noteModelSenderStats(async () => snapshot)
    noteModelSenderStats(async () => null)
    noteModelSenderStats(undefined)
    noteModelSenderStats(async () => {
      throw new Error('нет соединения')
    })
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    const added = getTrace().filter((entry) => entry.id > mark && entry.title === 'Модель: отправитель звука')
    expect(added).toHaveLength(1)
    expect(added[0]?.detail).toEqual(snapshot)
  })
})
