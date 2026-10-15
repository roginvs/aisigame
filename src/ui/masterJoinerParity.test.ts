import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createActor } from 'xstate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildConferenceSnapshot } from '../conference/buildSnapshot.ts'
import { emptyMessageRing } from '../conference/messageRing.ts'
import { contextFromSnapshot, resetTimerAnchor } from '../conference/snapshotView.ts'
import { gameMachine, statePath } from '../game/machine.ts'
import type { Player, Question, QuestionPack } from '../game/types.ts'
import { GameScreen } from './GameScreen.tsx'

const pack: QuestionPack = {
  name: 'Паритет',
  rounds: [{ index: 0, name: 'Р', kind: 'normal' }],
  questions: [
    { id: 'q1', roundIndex: 0, themeId: 't', themeName: 'Тема', value: 100, text: 'Что появилось раньше?', answers: ['D'],
      choices: [{ label: 'A', text: 'Один' }, { label: 'D', text: 'Четыре' }] },
    { id: 'q2', roundIndex: 0, themeId: 't', themeName: 'Тема', value: 200, text: 'Второй?', answers: ['да'] },
  ] as Question[],
  warnings: [],
}

function start() {
  const players: Player[] = [
    { id: 1, name: 'Мастер', score: 0, clientId: 'm' },
    { id: 2, name: 'Гость', score: 100, clientId: 'g' },
  ]
  const actor = createActor(gameMachine).start()
  actor.send({ type: 'START_GAME', pack, players })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  return actor
}

/** Один снимок → экран мастера и гостя; различаться могут только кнопки управления мастера. */
function render(actor: ReturnType<typeof start>, isMaster: boolean): string {
  const local = actor.getSnapshot()
  const snapshot = buildConferenceSnapshot({
    phase: statePath(local.value), pack: null, context: local.context, roster: [], timerRemainingMs: null, falseStartIds: [],
    hostEar: 'hearing', liveSpeech: { text: 'август', at: '2026-10-15T17:00:00.000Z' }, hostLink: { host: 'idle', mic: 'live' }, hearTurnOnly: true,
  })
  resetTimerAnchor()
  const context = contextFromSnapshot(snapshot, pack)
  const noop = () => undefined
  return renderToStaticMarkup(createElement(GameScreen, {
    snapshot: local, link: { connection: 'connected', mic: 'live', host: 'speaking' },
    onBuzz: noop, onPick: noop, onPause: noop, onStop: noop, onReset: noop, onNextRound: noop,
    modelId: 'mock', onModel: noop,
    conference: {
      layout: true, lobby: false, roster: [], isMaster, masterOffline: false, waitingMaster: false, readyDisabled: false,
      selfClientId: 'g', remoteSnapshot: snapshot, remoteContext: context, remotePath: snapshot.phase,
      tiles: [], messageRing: emptyMessageRing(), hearTurnOnly: true,
    },
  }))
}

/** Убрать то, что по роли и должно отличаться: верхнюю панель управления и класс вида гостя. */
function shared(html: string): string {
  return html
    .replace(/<header class="topbar">[\s\S]*?<\/header>/, '')
    .replace(/ joiner-view/g, '')
}

describe('мастер и гость рисуют один и тот же снимок одинаково', () => {
  afterEach(() => resetTimerAnchor())

  it('выбор, вопрос и пауза: экран совпадает кроме панели мастера', () => {
    const actor = start()
    const phases: string[] = []
    const check = () => {
      phases.push(statePath(actor.getSnapshot().value))
      const master = render(actor, true)
      const joiner = render(actor, false)
      expect(master).toContain('class="topbar"')
      expect(shared(joiner)).toBe(shared(master))
    }
    check()
    actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 100 })
    check()
    actor.send({ type: 'PAUSE', path: statePath(actor.getSnapshot().value) })
    check()
    expect(phases[0]).toMatch(/^choosing/)
    expect(phases.at(-1)).toBe('paused')
    actor.stop()
  })
})
