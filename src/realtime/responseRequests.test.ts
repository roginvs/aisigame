import { describe, expect, it } from 'vitest'
import { ResponseRequests } from './responseRequests.ts'

describe('владельцы отправленных запросов', () => {
  it('поздний created остаётся за старой отправкой, дубликат не сдвигает очередь', () => {
    const requests = new ResponseRequests()
    const old = requests.sent({ metadata: { purpose: 'judge', turn: '41' } })
    const current = requests.sent({ metadata: { purpose: 'judge', turn: '42' } })
    requests.created({ id: 'old' })
    requests.created({ id: 'old' })
    requests.created({ id: 'current' })
    expect(requests.get({ id: 'old' })).toEqual(old)
    expect(requests.get({ id: 'current' })).toEqual(current)
    expect(requests.get({ id: 'unknown' })).toBeUndefined()
  })

  it('помеченные параллельные ответы могут создаваться в обратном порядке', () => {
    const requests = new ResponseRequests()
    const judge = requests.sent({ metadata: { purpose: 'judge', turn: '4', requestId: 'audio-4' } })
    const speech = requests.sent({ metadata: { purpose: 'read', turn: '4' } })
    requests.created({ id: 'speech', metadata: { purpose: 'read', turn: '4' } })
    requests.created({ id: 'judge', metadata: { requestId: 'audio-4' } })
    expect(requests.get({ id: 'speech' })).toEqual(speech)
    expect(requests.get({ id: 'judge' })).toEqual(judge)
  })

  it('отвергнутая отправка и новая сессия не сдвигают владельца следующего ответа', () => {
    const requests = new ResponseRequests()
    requests.sent({ metadata: { purpose: 'judge', turn: '1' } }, 'failed')
    const retry = requests.sent({ metadata: { purpose: 'judge', turn: '1' } })
    requests.rejected('failed')
    requests.created({ id: 'retry' })
    expect(requests.get({ id: 'retry' })).toEqual(retry)
    requests.sent({ metadata: { purpose: 'judge', turn: '2' } })
    requests.reset()
    const next = requests.sent({ metadata: { purpose: 'judge', turn: '3' } })
    requests.created({ id: 'next' })
    expect(requests.get({ id: 'retry' })).toBeUndefined()
    expect(requests.get({ id: 'next' })).toEqual(next)
    expect(next.eventId).not.toBe(retry.eventId)
  })
})
