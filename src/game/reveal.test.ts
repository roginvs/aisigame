import { describe, expect, it } from 'vitest'
import { answerIsPublic, chatAnswerNote, publicAnswerHasPlayable, stageMedia } from './reveal.ts'
import type { QuestionMedia } from './types.ts'

describe('answerIsPublic', () => {
  it('показывает ответ, если никто не ответил или все ошиблись', () => {
    expect(answerIsPublic('nobody', true)).toBe(true)
    expect(answerIsPublic('incorrect', true)).toBe(true)
    expect(answerIsPublic('silence', true)).toBe(true)
    expect(answerIsPublic('unclear', true)).toBe(true)
  })

  it('прячет ответ после верного и пока ячейка ещё открыта', () => {
    expect(answerIsPublic('correct', true)).toBe(false)
    expect(answerIsPublic('incorrect', false)).toBe(false)
    expect(answerIsPublic('silence', false)).toBe(false)
    expect(answerIsPublic('nobody', false)).toBe(false)
    expect(answerIsPublic('unclear', false)).toBe(false)
  })
})

describe('publicAnswerHasPlayable', () => {
  it('нужен публичный эталон и звук или ролик ответа', () => {
    expect(
      publicAnswerHasPlayable({
        kind: 'nobody',
        cellClosed: true,
        answerMedia: [{ kind: 'audio', name: 'song.mp3', url: 'blob:1' }],
      }),
    ).toBe(true)
    expect(
      publicAnswerHasPlayable({
        kind: 'nobody',
        cellClosed: true,
        answerMedia: [{ kind: 'video', name: 'clip.mp4', url: 'blob:2' }],
      }),
    ).toBe(true)
    expect(
      publicAnswerHasPlayable({
        kind: 'nobody',
        cellClosed: true,
        answerMedia: [{ kind: 'image', name: 'art.png', url: 'blob:3' }],
      }),
    ).toBe(false)
    expect(
      publicAnswerHasPlayable({
        kind: 'correct',
        cellClosed: true,
        answerMedia: [{ kind: 'audio', name: 'song.mp3', url: 'blob:1' }],
      }),
    ).toBe(false)
  })
})

describe('chatAnswerNote', () => {
  it('после верного закрытого вопроса пишет эталон под репликой', () => {
    expect(
      chatAnswerNote({
        kind: 'correct',
        cellClosed: true,
        answers: ['Солнце'],
        spoken: 'Верно, плюс 100.',
      }),
    ).toBe('Правильный ответ: Солнце')
    expect(
      chatAnswerNote({
        kind: 'correct',
        cellClosed: true,
        answers: ['Октавиан Август', 'Август'],
        spoken: 'Правильно, плюс двести.',
      }),
    ).toBe('Правильный ответ: Октавиан Август, Август')
  })

  it('не пишет эталон, пока ячейка ещё открыта', () => {
    expect(
      chatAnswerNote({
        kind: 'correct',
        cellClosed: false,
        answers: ['Солнце'],
        spoken: 'Верно, плюс 100.',
      }),
    ).toBe('')
    expect(
      chatAnswerNote({
        kind: 'incorrect',
        cellClosed: false,
        answers: ['Солнце'],
        spoken: 'Неверно, минус 100.',
      }),
    ).toBe('')
  })

  it('не дублирует эталон, если ведущая уже произнесла его', () => {
    expect(
      chatAnswerNote({
        kind: 'nobody',
        cellClosed: true,
        answers: ['Солнце'],
        spoken: 'Никто не нажал. Солнце.',
      }),
    ).toBe('')
    expect(
      chatAnswerNote({
        kind: 'incorrect',
        cellClosed: true,
        answers: ['Красный', 'красного цвета'],
        spoken: 'Неверно. Красный или красного цвета.',
      }),
    ).toBe('')
  })

  it('дописывает эталон, если вслух прозвучал другой факт', () => {
    expect(
      chatAnswerNote({
        kind: 'silence',
        cellClosed: true,
        answers: ['Солнце'],
        spoken: 'Время вышло. Сириус.',
      }),
    ).toBe('Правильный ответ: Солнце')
  })

  it('пишет эталон, когда закрытый ответ не разобрали, и молчит без ответов пакета', () => {
    expect(
      chatAnswerNote({
        kind: 'unclear',
        cellClosed: true,
        answers: ['Солнце'],
        spoken: 'Не засчитала.',
      }),
    ).toBe('Правильный ответ: Солнце')
    expect(
      chatAnswerNote({
        kind: 'correct',
        cellClosed: true,
        answers: ['  '],
        spoken: 'Верно.',
      }),
    ).toBe('')
  })
})

const picture = (name: string): QuestionMedia => ({ kind: 'image', name, url: name })
const clip = (name: string): QuestionMedia => ({ kind: 'video', name, url: name })
const sound = (name: string): QuestionMedia => ({ kind: 'audio', name, url: name })

describe('stageMedia', () => {
  const questionMedia = [picture('вопрос.png'), clip('вопрос.mp4'), sound('вопрос.mp3')]

  it('пока ответ скрыт, на табло только медиа вопроса', () => {
    const staged = stageMedia(questionMedia, [clip('ответ.mp4'), sound('ответ.mp3')], false)
    expect(staged.slot.map((item) => item.name)).toEqual(['вопрос.png', 'вопрос.mp4', 'вопрос.mp3'])
    expect(staged.answerVisual).toEqual([])
    expect(staged.answerAudio).toEqual([])
  })

  it('ролик ответа занимает место картинки и ролика вопроса', () => {
    const staged = stageMedia(questionMedia, [clip('ответ.mp4'), picture('ответ.png'), sound('ответ.mp3')], true)
    expect(staged.slot.map((item) => item.name)).toEqual(['ответ.mp4', 'ответ.png', 'вопрос.mp3'])
    expect(staged.slot.some((item) => item.name === 'вопрос.png' || item.name === 'вопрос.mp4')).toBe(false)
    expect(staged.answerAudio.map((item) => item.name)).toEqual(['ответ.mp3'])
  })

  it('один звук ответа оставляет картинку вопроса', () => {
    const staged = stageMedia(questionMedia, [sound('ответ.mp3')], true)
    expect(staged.slot.map((item) => item.name)).toEqual(['вопрос.png', 'вопрос.mp4', 'вопрос.mp3'])
    expect(staged.answerVisual).toEqual([])
    expect(staged.answerAudio.map((item) => item.name)).toEqual(['ответ.mp3'])
  })
})
