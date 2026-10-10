/** Транспорт ведущей. Сессия говорит событиями OpenAI Realtime, провод переводит их в протокол модели. */
export interface VoiceWire {
  open(apiKey: string, sink: VoiceSink): Promise<void>
  send(event: object): boolean
  close(): void
  setMicEnabled(enabled: boolean): void
  setOutputMuted(muted: boolean): void
}

export type VoiceSink = {
  message: (raw: string) => void
  closed: (message: string) => void
}
