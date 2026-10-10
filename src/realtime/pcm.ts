import { gameAudioContext } from '../audio/beep.ts'

/** PCM16 little-endian в base64 и обратно. Так аудио едет по WebSocket у Grok и Gemini. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return bytesToBase64(bytes)
}

export function base64ToPcm(data: string): Int16Array {
  const bytes = base64ToBytes(data)
  const even = bytes.byteLength - (bytes.byteLength % 2)
  const copy = bytes.slice(0, even)
  return new Int16Array(copy.buffer, copy.byteOffset, even / 2)
}

export function downsample(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) return new Int16Array()
  if (fromRate === toRate) return floatToPcm(input)
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Int16Array(length)
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)))
    let sum = 0
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor] ?? 0
    out[index] = clampSample(sum / (end - start))
  }
  return out
}

/** Проигрывает исходящие куски ведущей подряд, без щелчка между ними. */
export class PcmPlayer {
  private next = 0
  private pending = 0
  private started = false
  private finishing = false
  private muted = false
  private epoch = 0
  private nodes: AudioBufferSourceNode[] = []
  private readonly rate: number
  private readonly onStarted: () => void
  private readonly onDrained: () => void

  constructor(rate: number, onStarted: () => void, onDrained: () => void) {
    this.rate = rate
    this.onStarted = onStarted
    this.onDrained = onDrained
  }

  enqueue(pcm: Int16Array): void {
    if (this.muted || pcm.length === 0) return
    const ctx = gameAudioContext()
    void ctx.resume()
    const buffer = ctx.createBuffer(1, pcm.length, this.rate)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < pcm.length; index += 1) channel[index] = (pcm[index] ?? 0) / 32768
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const epoch = this.epoch
    const startAt = Math.max(ctx.currentTime + 0.02, this.next)
    source.start(startAt)
    this.next = startAt + buffer.duration
    this.pending += 1
    this.nodes.push(source)
    if (!this.started) {
      this.started = true
      this.onStarted()
    }
    source.onended = () => {
      if (epoch !== this.epoch) return
      this.pending = Math.max(0, this.pending - 1)
      if (this.pending === 0 && this.finishing) this.drain()
    }
  }

  /** Генерация кончилась: доиграть очередь и сказать, что буфер пуст. */
  finish(): void {
    if (!this.started) return
    if (this.pending === 0) this.drain()
    else this.finishing = true
  }

  stop(): void {
    this.epoch += 1
    for (const node of this.nodes) {
      try {
        node.onended = null
        node.stop()
      } catch {
        // кусок уже доиграл
      }
    }
    this.nodes = []
    this.pending = 0
    this.started = false
    this.finishing = false
    this.next = 0
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.stop()
  }

  private drain(): void {
    this.started = false
    this.finishing = false
    this.pending = 0
    this.nodes = []
    this.next = 0
    this.onDrained()
  }
}

/** Микрофон комнаты кусками PCM. Дорожка глушится, пока ведущая говорит: так же, как у OpenAI. */
export class PcmMic {
  private enabled = false
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private mute: GainNode | null = null
  private readonly rate: number
  private readonly onPcm: (pcm: Int16Array) => void

  constructor(rate: number, onPcm: (pcm: Int16Array) => void) {
    this.rate = rate
    this.onPcm = onPcm
  }

  async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    for (const track of this.stream.getAudioTracks()) track.enabled = false
    const ctx = gameAudioContext()
    void ctx.resume()
    const source = ctx.createMediaStreamSource(this.stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => {
      if (!this.enabled) return
      const input = event.inputBuffer.getChannelData(0)
      const pcm = downsample(input, ctx.sampleRate, this.rate)
      if (pcm.length) this.onPcm(pcm)
    }
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(processor)
    processor.connect(mute)
    mute.connect(ctx.destination)
    this.source = source
    this.processor = processor
    this.mute = mute
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled
    })
  }

  close(): void {
    this.enabled = false
    this.processor?.disconnect()
    this.mute?.disconnect()
    this.source?.disconnect()
    this.processor = null
    this.mute = null
    this.source = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }
}

function floatToPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) out[index] = clampSample(input[index] ?? 0)
  return out
}

function clampSample(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
