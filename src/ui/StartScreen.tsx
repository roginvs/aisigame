import { useRef } from 'react'
import { ownPackId, packCatalog } from '../game/catalog.ts'
import type { LinkStatus } from '../realtime/client.ts'
import { keyFieldLabel, voiceById, voiceModels } from '../realtime/models.ts'
import { startupStatus } from './startupStatus.ts'

const packFileAccept = '.siq,.zip,.xml,application/zip,text/xml'

export function StartScreen(props: {
  apiKey: string
  showKey: boolean
  link: LinkStatus
  error: string | null
  busy: boolean
  loadingPack: boolean
  packId: string
  modelId: string
  onModel: (id: string) => void
  packReady: boolean
  needsKey: boolean
  packSummary: string
  packWarnings: string[]
  playerNames: string
  onPlayerNames: (value: string) => void
  onApiKey: (value: string) => void
  onToggleKey: () => void
  onClearKey: () => void
  onPack: (id: string) => void
  onFile: (file: File) => void
  onStart: () => void
  canContinue: boolean
  resumeFromDisk: boolean
  resumePackName: string
  resumeFileName: string
  readingResume: boolean
  onContinue: () => void
  onResumeFile: (file: File) => void
}) {
  const {
    apiKey,
    showKey,
    link,
    error,
    busy,
    loadingPack,
    packId,
    modelId,
    onModel,
    packReady,
    needsKey,
    packSummary,
    packWarnings,
    playerNames,
    onPlayerNames,
    onApiKey,
    onToggleKey,
    onClearKey,
    onPack,
    onFile,
    onStart,
    canContinue,
    resumeFromDisk,
    resumePackName,
    resumeFileName,
    readingResume,
    onContinue,
    onResumeFile,
  } = props
  const fileRef = useRef<HTMLInputElement>(null)
  const resumeFileRef = useRef<HTMLInputElement>(null)
  return (
    <main className="start">
      <section className="card">
        <p className="eyebrow">Голосовая викторина</p>
        <h1>Своя игра</h1>
        <p className="lead">
          Игроки за одним планшетом. Ведущая слушает и говорит сама. Ключ выбранной модели остаётся в этом
          браузере.
        </p>
        {needsKey ? null : (
          <p className="status-line">Заглушка ведущей: ключ не нужен, ответы подставляет игра.</p>
        )}
        <label className="field">
          <span>Модель</span>
          <select value={modelId} onChange={(event) => onModel(event.target.value)}>
            {voiceModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Пакет вопросов</span>
          <select
            value={packId}
            onChange={(event) => {
              const next = event.target.value
              if (next === ownPackId) {
                fileRef.current?.click()
                return
              }
              onPack(next)
            }}
          >
            {packCatalog.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
            <option value={ownPackId}>Выбрать свой…</option>
          </select>
          <input
            ref={fileRef}
            type="file"
            accept={packFileAccept}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) onFile(file)
            }}
          />
        </label>
        {packSummary ? <p className="status-line">{packSummary}</p> : null}
        {packWarnings.length > 0 ? (
          <ul className="warnings">
            {packWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <label className="field">
          <span>Имена игроков</span>
          <textarea
            rows={3}
            value={playerNames}
            placeholder={'Игрок 1\nИгрок 2\nИгрок 3'}
            spellCheck={false}
            onChange={(event) => onPlayerNames(event.target.value)}
          />
        </label>
        <p className="status-line">По одному имени в строке. Пустое поле — Игрок 1, Игрок 2 и Игрок 3.</p>
        {needsKey ? (
          <>
            <label className="field">
              <span>{keyFieldLabel(voiceById(modelId).provider)}</span>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onApiKey(event.target.value)}
              />
            </label>
            <div className="row">
              <button type="button" className="ghost" onClick={onToggleKey}>
                {showKey ? 'Скрыть ключ' : 'Показать ключ'}
              </button>
              <button type="button" className="ghost" onClick={onClearKey}>
                Удалить ключ
              </button>
            </div>
          </>
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={busy || readingResume || loadingPack || !packReady || (needsKey && apiKey.trim().length === 0)}
          onClick={onStart}
        >
          Начать игру
        </button>
        {resumeFromDisk && resumePackName ? <p className="status-line">Пак «{resumePackName}»</p> : null}
        <button
          type="button"
          className={resumeFileName ? 'ghost continue-with-file' : 'ghost'}
          disabled={!canContinue || busy || readingResume || (needsKey && apiKey.trim().length === 0)}
          onClick={() => {
            if (resumeFromDisk) {
              resumeFileRef.current?.click()
              return
            }
            onContinue()
          }}
        >
          <span>Продолжить прошлую игру</span>
          {resumeFileName ? <span className="continue-file">{resumeFileName}</span> : null}
        </button>
        <input
          ref={resumeFileRef}
          type="file"
          accept={packFileAccept}
          hidden
          data-resume-pack=""
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onResumeFile(file)
          }}
        />
        {busy ? <p className="status-line">{startupStatus(link)}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  )
}
