import type { ModelSenderStats } from './senderStats.ts'

export type VoiceOpenOptions = {
  /** false — тихий поток без разрешения микрофона (конференция до кнопки в панели). */
  captureMic?: boolean
}

/** Транспорт ведущей. Сессия говорит событиями OpenAI Realtime, провод переводит их в протокол модели. */
export interface VoiceWire {
  /** Провод принимает ручной input_audio_buffer.commit и возвращает committed. */
  readonly supportsInputCommit?: boolean
  /**
   * Граница кнопки: commit открытой реплики или clear хвоста.
   * Не включает запасной commit ответа (у Grok его нет, а разрез на кнопке есть).
   */
  readonly supportsButtonCut?: boolean
  /**
   * Чужой function_call (модель вызвала сама, не наш ход) нужно закрыть
   * `function_call_output`, иначе следующий response.create может не открыться.
   * У OpenAI изолированный ход такого ответа не ждёт: там это invalid_tool_call_id.
   */
  readonly acksForeignToolCalls?: boolean
  open(apiKey: string, sink: VoiceSink, options?: VoiceOpenOptions): Promise<void>
  send(event: object): boolean
  close(): void
  setMicEnabled(enabled: boolean): void
  setOutputMuted(muted: boolean): void
  /** Мастер Jitsi: false — ведущую слушаем из комнаты, локально не играем (поток в комнату идёт). */
  setLocalPlayback?(enabled: boolean): void
  /** Уровень речи ведущей 0..1 (что модель говорит) — индикатор мастера. */
  outputLevel?(): number
  attachHostOutput(handler: (stream: MediaStream) => void): void
  setInputStream(stream: MediaStream | null): void
  /** Снимок исходящего аудио WebRTC. Нет соединения — метод можно не реализовывать. */
  inputSenderStats?(): Promise<ModelSenderStats | null>
}

export type VoiceSink = {
  message: (raw: string) => void
  closed: (message: string) => void
}
