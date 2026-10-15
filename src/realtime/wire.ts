export type VoiceOpenOptions = {
  /** false — тихий поток без разрешения микрофона (конференция до кнопки в панели). */
  captureMic?: boolean
}

/** Транспорт ведущей. Сессия говорит событиями OpenAI Realtime, провод переводит их в протокол модели. */
export interface VoiceWire {
  open(apiKey: string, sink: VoiceSink, options?: VoiceOpenOptions): Promise<void>
  send(event: object): boolean
  close(): void
  setMicEnabled(enabled: boolean): void
  setOutputMuted(muted: boolean): void
  /** Мастер Jitsi: false — ведущую слушаем из комнаты, локально не играем (поток в комнату идёт). */
  setLocalPlayback?(enabled: boolean): void
  attachHostOutput(handler: (stream: MediaStream) => void): void
  setInputStream(stream: MediaStream | null): void
}

export type VoiceSink = {
  message: (raw: string) => void
  closed: (message: string) => void
}
