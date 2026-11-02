/**
 * Только dev-стенд `?transport=broadcast&fakeConference=1` (e2e/live/turn.live.play.ts).
 * Конференция без Jitsi: удалённые игроки — дорожки WebAudio у мастера, звук им даёт
 * `window.__fakeConf.say(id, wav)`. Микс модели — настоящий createMicMixer, конец речи
 * на шине — настоящий createModelStreamSpeech. id участника = senderId его broadcast-транспорта.
 */
import { createMicMixer, type ModelHearFocus } from './audioMix.ts'
import { createBroadcastMedia, type ConferenceHandle, type ConferenceTile } from './media.ts'
import { createModelStreamSpeech, createSpeechLevels } from './speechLevel.ts'
import { BroadcastChannelTransport } from './transport.ts'
import { pushTrace } from '../debug/trace.ts'
import { hearWindowSampleMs } from '../options.ts'

export const fakeConferenceEnabled = (): boolean =>
  import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('fakeConference') === '1'

export function fakeSenderId(displayName: string): string {
  return `fake-${displayName.trim()}`
}

type Remote = { id: string; name: string; ctx: AudioContext; dest: MediaStreamAudioDestinationNode }

export function createFakeConference(roomId: string, displayName: string): ConferenceHandle {
  const transport = new BroadcastChannelTransport(roomId)
  ;(transport as unknown as { senderId: string }).senderId = fakeSenderId(displayName)
  const base = createBroadcastMedia(displayName)
  const selfId = fakeSenderId(displayName)
  const ctx = new AudioContext()
  const remotes = new Map<string, Remote>()
  const owners = new Set<() => void>()
  const tiles = new Set<(t: ConferenceTile[]) => void>()
  const activity = new Set<(id: string, end?: { durationMs: number }) => void>()
  const streamStart = new Set<() => void>()
  const streamEnd = new Set<(ms: number) => void>()
  let focus: ModelHearFocus = null
  const mixer = createMicMixer((event) => pushTrace('note', 'Модель: источник микса', event))
  const levels = createSpeechLevels((id) => { for (const l of activity) l(id) }, Date.now, (id, durationMs) => { for (const l of activity) l(id, { durationMs }) })
  const bus = createModelStreamSpeech(() => { for (const l of streamStart) l() }, (ms) => { for (const l of streamEnd) l(ms) })
  const sync = () => mixer.update({
    remotes: [...remotes.values()].map((r) => ({ key: r.id, participantId: r.id, stream: r.dest.stream, muted: false })),
    local: { participantId: selfId, stream: base.localMicStream(), live: base.micLive() },
    focus,
  })
  const emitTiles = () => {
    const list: ConferenceTile[] = [
      { id: selfId, name: displayName, isLocal: true, micLive: base.micLive(), cameraOn: false, speaking: false },
      ...[...remotes.values()].map((r) => ({ id: r.id, name: r.name, isLocal: false, micLive: true, cameraOn: false, speaking: false })),
    ]
    for (const l of tiles) l(list)
  }
  const timer = window.setInterval(() => {
    sync()
    bus.noteBus(mixer.busLevel().rms)
    for (const level of mixer.levels()) {
      if (!level.key.startsWith('remote-')) continue
      levels.note(level.key.slice('remote-'.length), Math.min(1, level.rms * 4))
    }
  }, hearWindowSampleMs)
  const api = {
    addRemote(name: string) {
      const id = fakeSenderId(name)
      if (remotes.has(id)) return id
      remotes.set(id, { id, name, ctx, dest: ctx.createMediaStreamDestination() })
      sync()
      emitTiles()
      for (const l of owners) l()
      return id
    },
    async say(name: string, b64: string) {
      const r = remotes.get(fakeSenderId(name)) ?? remotes.get(api.addRemote(name))!
      await ctx.resume()
      const src = ctx.createBufferSource()
      src.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer)
      src.connect(r.dest)
      pushTrace('note', `стенд: говорит ${name}`, { seconds: src.buffer.duration })
      await new Promise<void>((res) => { src.onended = () => res(); src.start() })
      pushTrace('note', `стенд: замолчал ${name}`)
    },
    levels: () => mixer.levels(),
    focus: () => focus,
  }
  ;(window as unknown as { __fakeConf: typeof api }).__fakeConf = api
  return {
    ...base,
    transport,
    modelInputStream: () => { sync(); return mixer.outputStream() },
    modelMeter: () => mixer.meter(),
    setModelHearOnly(next) {
      focus = next
      pushTrace('note', 'Модель: фокус микшера', { focus: next === null ? 'null' : next === false ? 'false' : String(next) })
      sync()
    },
    liveAudioOwnerIds: () => [selfId, ...remotes.keys()],
    liveAudioOwners: () => [{ id: selfId, name: '' }, ...[...remotes.values()].map((r) => ({ id: r.id, name: r.name }))],
    subscribeAudioOwners(h) { owners.add(h); return () => owners.delete(h) },
    focusedTrackMissing() {
      if (focus === null) return false
      if (focus === false) return true
      const ids = typeof focus === 'string' ? [focus] : focus
      return ids.length === 0
    },
    anyoneSpeaking: () => mixer.levels().some((l) => l.rms > 0.02),
    localParticipantId: () => selfId,
    subscribeTiles(h) { tiles.add(h); emitTiles(); return () => tiles.delete(h) },
    subscribeSpeechActivity(h) { activity.add(h); return () => activity.delete(h) },
    subscribeModelStream(h) { streamEnd.add(h); return () => streamEnd.delete(h) },
    subscribeModelStreamStart(h) { streamStart.add(h); return () => streamStart.delete(h) },
    dispose() {
      window.clearInterval(timer)
      levels.dispose()
      bus.dispose()
      mixer.dispose()
      void ctx.close().catch(() => undefined)
      base.dispose()
      transport.close()
    },
  }
}
