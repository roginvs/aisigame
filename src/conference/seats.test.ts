import { describe, expect, it } from 'vitest'
import {
  conferenceDisplayName,
  deviceSpeechPlayerId,
  helloSeatNames,
  rosterSeats,
  seatLabel,
  seatNamesFromText,
} from './seats.ts'

describe('seatNamesFromText', () => {
  it('режет по точке с запятой и новой строке, пустые куски выкидывает', () => {
    expect(seatNamesFromText('Аня; Боря\n\nВика')).toEqual(['Аня', 'Боря', 'Вика'])
    expect(seatNamesFromText('   ')).toEqual([])
    expect(seatNamesFromText('Гость')).toEqual(['Гость'])
  })

  it('склеивает подпись устройства', () => {
    expect(seatLabel(['Аня', 'Боря'])).toBe('Аня, Боря')
    expect(conferenceDisplayName('Аня; Боря')).toBe('Аня, Боря')
    expect(conferenceDisplayName('Гость')).toBe('Гость')
  })

  it('старый hello с одним name остаётся одним местом', () => {
    expect(helloSeatNames({ name: 'Гость' })).toEqual(['Гость'])
    expect(helloSeatNames({ name: 'Гость', names: ['Аня', 'Боря'] })).toEqual(['Аня', 'Боря'])
  })

  it('без seats в снимке место одно', () => {
    expect(rosterSeats({ name: 'Гость', playerId: 2 })).toEqual([{ name: 'Гость', playerId: 2 }])
    expect(rosterSeats({
      name: 'Аня, Боря',
      playerId: 2,
      seats: [{ name: 'Аня', playerId: 2 }, { name: 'Боря', playerId: 3 }],
    })).toEqual([{ name: 'Аня', playerId: 2 }, { name: 'Боря', playerId: 3 }])
  })
})

describe('deviceSpeechPlayerId', () => {
  const seats = [2, 3]

  it('на ответе берёт место, чей сейчас ход, а не первое на устройстве', () => {
    expect(deviceSpeechPlayerId({
      seatIds: seats,
      phase: 'answering.waiting',
      answererId: 3,
      chooserId: 2,
      missedIds: [],
      listenerId: null,
    })).toBe(3)
  })

  it('речь устройства на чужом ходе остаётся id своего места, не отвечающего', () => {
    expect(deviceSpeechPlayerId({
      seatIds: seats,
      phase: 'answering.waiting',
      answererId: 1,
      chooserId: 1,
      missedIds: [],
      listenerId: null,
    })).toBe(2)
  })

  it('в окне кнопки пропускает того, кто уже отвечал', () => {
    expect(deviceSpeechPlayerId({
      seatIds: seats,
      phase: 'buzzing.open',
      answererId: null,
      chooserId: 1,
      missedIds: [2],
      listenerId: null,
    })).toBe(3)
  })
})
