import { packProgressLabel, type PackPhase, type PackProgressView } from '../conference/packProgress.ts'

export type PackAwaitProgress = PackProgressView & {
  hashOk: boolean
  ready: boolean
  packPhase?: PackPhase
}

/** Место табло, пока у joiner партия уже в снимке, а пакет ещё не готов. */
export function PackAwaitPanel(props: {
  progress: PackAwaitProgress
  packName?: string
}) {
  const { progress, packName } = props
  const percent = Math.max(0, Math.min(100, progress.percent))
  return (
    <article className="question pack-await" aria-live="polite">
      <p className="eyebrow">{packName?.trim() || 'Конференция'}</p>
      <h2>Игра уже началась</h2>
      <p className="lead">Догружаем пакет вопросов — поле откроется, когда файл сверится.</p>
      <div className="roster-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      <p className="status-line">{packProgressLabel(progress)}</p>
    </article>
  )
}
