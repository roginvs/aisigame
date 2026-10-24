import { useRef } from 'react'
import { ownPackId, packCatalog } from '../game/catalog.ts'
import { defaultPlayerNames } from '../game/players.ts'
import type { MatchMode } from '../conference/prefs.ts'
import { seatNamesFromText } from '../conference/seats.ts'
import type { LinkStatus } from '../realtime/client.ts'
import { keyFieldLabel, voiceById, voiceModels } from '../realtime/models.ts'
import { startBuildInfo } from '../buildInfo.ts'
import { startupStatus } from './startupStatus.ts'

const packFileAccept = '.siq,.zip,.xml,application/zip,text/xml'

export function StartScreen(props: {
  apiKey: string
  showKey: boolean
  link: LinkStatus
  error: string | null
  busy: boolean
  busyStatus?: string | null
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
  qwenEndpoint: string
  onQwenEndpoint: (value: string) => void
  qwenRelay: string
  onQwenRelay: (value: string) => void
  isolateHistory: boolean
  onIsolateHistory: (enabled: boolean) => void
  onToggleKey: () => void
  onClearKey: () => void
  onPack: (id: string) => void
  onFile: (file: File) => void
  onStart: () => void
  canContinue: boolean
  resumeFromDisk: boolean
  resumePackName: string
  resumeMode: MatchMode | null
  readingResume: boolean
  onContinue: () => void
  onResumeFile: (file: File) => void
  modelSwitched: boolean
  matchMode: MatchMode
  onMatchMode: (mode: MatchMode) => void
  conferenceName: string
  onConferenceName: (value: string) => void
  jitsiUrl: string
  onJitsiUrl: (value: string) => void
}) {
  const {
    apiKey,
    showKey,
    link,
    error,
    busy,
    busyStatus,
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
    qwenEndpoint,
    onQwenEndpoint,
    qwenRelay,
    onQwenRelay,
    isolateHistory,
    onIsolateHistory,
    onToggleKey,
    onClearKey,
    onPack,
    onFile,
    onStart,
    canContinue,
    resumeFromDisk,
    resumePackName,
    resumeMode,
    readingResume,
    onContinue,
    onResumeFile,
    modelSwitched,
    matchMode,
    onMatchMode,
    conferenceName,
    onConferenceName,
    jitsiUrl,
    onJitsiUrl,
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
        <div className="start-grid">
          <div className="start-col">
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
            {matchMode === 'table' ? (
              <>
                <label className="field">
                  <span>Имена игроков</span>
                  <textarea
                    rows={3}
                    value={playerNames}
                    placeholder={defaultPlayerNames}
                    spellCheck={false}
                    onChange={(event) => onPlayerNames(event.target.value)}
                  />
                </label>
                <p className="status-line">
                  Имя с новой строки или через точку с запятой. Пустое поле — Игрок 1, Игрок 2 и Игрок 3.
                </p>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Ваше имя</span>
                  <textarea
                    rows={2}
                    value={conferenceName}
                    placeholder="Аня; Боря"
                    spellCheck={false}
                    onChange={(event) => onConferenceName(event.target.value)}
                  />
                </label>
                <p className="status-line">
                  Имя с новой строки или через точку с запятой — вы и остальные за этим устройством.
                </p>
              </>
            )}
          </div>
          <div className="start-col">
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
            {needsKey ? null : (
              <p className="status-line">Заглушка ведущей: ключ не нужен, ответы подставляет игра.</p>
            )}
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
                {voiceById(modelId).provider === 'qwen' ? (
                  <>
                    <label className="field">
                      <span>Адрес workspace DashScope</span>
                      <input
                        value={qwenEndpoint}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="ws-xxxx.cn-beijing.maas.aliyuncs.com"
                        onChange={(event) => onQwenEndpoint(event.target.value)}
                      />
                    </label>
                    <p className="status-line">
                      Адрес из личного кабинета DashScope: можно только id workspace (регион будет Пекин) или полный хост,
                      например ws-xxxx.cn-beijing.maas.aliyuncs.com; у сингапурского workspace — ws-xxxx.ap-southeast-1.maas.aliyuncs.com.
                    </p>
                    <label className="field">
                      <span>Адрес релея (необязательно)</span>
                      <input
                        value={qwenRelay}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="/qwen-relay"
                        onChange={(event) => onQwenRelay(event.target.value)}
                      />
                    </label>
                    <p className="status-line">
                      DashScope не пускает браузер напрямую (нет CORS), поэтому обмен SDP идёт через релей:
                      «/qwen-relay» под dev-сервером этого проекта или адрес своего Worker (deploy — relay/README.md).
                      Пусто — прямой вызов, без релея сайт не подключится.
                    </p>
                  </>
                ) : null}
                {voiceById(modelId).provider === 'qwen' || voiceById(modelId).provider === 'google' ? (
                  <>
                    <div className="row">
                      <button type="button" className="ghost" onClick={() => onIsolateHistory(!isolateHistory)}>
                        {isolateHistory ? 'Вопрос и эталон не копятся в истории' : 'Вопрос и эталон остаются в истории'}
                      </button>
                    </div>
                    <p className="status-line">
                      Только Qwen и Gemini, включено по умолчанию. Текст чтения и оценки живёт в инструкции
                      этого хода и заменяется следующим. OpenAI и Grok так уже устроены и кнопку не показывают.
                      Выключите, если на чтении или оценке модель молчит.
                    </p>
                  </>
                ) : null}
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
            {matchMode === 'conference' ? (
              <label className="field">
                <span>Адрес Jitsi</span>
                <input value={jitsiUrl} spellCheck={false} onChange={(event) => onJitsiUrl(event.target.value)} />
              </label>
            ) : null}
          </div>
        </div>
        <fieldset className="mode-switch">
          <legend className="visually-hidden">Режим игры</legend>
          <label>
            <input
              type="radio"
              name="match-mode"
              checked={matchMode === 'table'}
              onChange={() => onMatchMode('table')}
            />
            За столом
          </label>
          <label>
            <input
              type="radio"
              name="match-mode"
              checked={matchMode === 'conference'}
              onChange={() => onMatchMode('conference')}
            />
            Конференция
          </label>
        </fieldset>
        <button
          type="button"
          className="primary"
          disabled={
            busy ||
            readingResume ||
            loadingPack ||
            !packReady ||
            (needsKey && apiKey.trim().length === 0) ||
            (matchMode === 'conference' && seatNamesFromText(conferenceName).length === 0)
          }
          onClick={onStart}
        >
          Начать игру
        </button>
        {modelSwitched && canContinue ? (
          <p className="status-line">Модель сохранена. Партию можно продолжить.</p>
        ) : null}
        {resumeFromDisk && resumePackName ? <p className="status-line">Пак «{resumePackName}»</p> : null}
        <button
          type="button"
          className={resumeMode ? 'ghost continue-with-file' : 'ghost'}
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
          {resumeMode && resumePackName ? (
            <span className="continue-file">
              {resumeMode === 'conference' ? 'Онлайн' : 'За столом'} · {resumePackName}
            </span>
          ) : null}
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
        {busy ? <p className="status-line">{busyStatus?.trim() || startupStatus(link)}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        <p className="build-info">{startBuildInfo()}</p>
      </section>
    </main>
  )
}
