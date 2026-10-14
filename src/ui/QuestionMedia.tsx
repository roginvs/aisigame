import { useCallback, useEffect, useRef, useState } from 'react'
import { attachQuestionMeter } from '../audio/questionMeter.ts'
import type { QuestionMedia as MediaItem } from '../game/types.ts'
import { QuestionMeter } from './QuestionMeter.tsx'
import { applyQuestionClip } from './questionClip.ts'

export function QuestionMedia(props: {
  media: MediaItem[]
  play: boolean
  quiet?: ReadonlySet<string>
  answer?: boolean
  /** Картинка и ролик ответа лежат в той же стопке, что и оставшийся звук вопроса. */
  answerUrls?: ReadonlySet<string>
  /** Клип ответа доиграл до конца (клип ответа не зацикливается). */
  onAnswerEnded?: () => void
}) {
  const { media, play, quiet, answer = false, answerUrls, onAnswerEnded } = props
  if (!media.length) return null
  return (
    <div className="question-media">
      {media.map((item) => {
        if (!item.url) return <p key={item.name}>Файл не найден: {item.name}</p>
        const live = itemLive(item, play, quiet)
        const reveal = answer || Boolean(item.url && answerUrls?.has(item.url))
        if (item.kind === 'image') return <img key={item.url} src={item.url} alt={mediaLabel('image', reveal)} />
        return (
          <QuestionClip key={item.url} kind={item.kind} url={item.url} live={live} label={mediaLabel(item.kind, reveal)}
            once={reveal} onEnded={reveal ? onAnswerEnded : undefined} />
        )
      })}
    </div>
  )
}

/** Звук или ролик без кнопок плеера: сам стартует и крутится, пока `live`. */
export function QuestionClip(props: {
  kind: 'audio' | 'video'; url: string; live: boolean; label: string
  /** Клип ответа: играет один раз, конец сообщает `onEnded`. */
  once?: boolean
  onEnded?: () => void
}) {
  const { kind, url, live, label, once = false, onEnded } = props
  const nodeRef = useRef<HTMLMediaElement | null>(null)
  const [node, setNode] = useState<HTMLMediaElement | null>(null)
  const [audioOnlyVideo, setAudioOnlyVideo] = useState(false)
  const takeNode = useCallback((next: HTMLMediaElement | null) => {
    nodeRef.current = next
    setNode((current) => (current === next ? current : next))
  }, [])
  const showMeter = kind === 'audio' || audioOnlyVideo

  useEffect(() => {
    const current = nodeRef.current
    if (!current) return
    try {
      // звук и ролик идут через один граф с мягким лимитером
      attachQuestionMeter(current)
    } catch {
      // элемент уже отдан другому графу — клип остаётся на своём выходе
    }
    applyQuestionClip(current, live)
  }, [live, url])

  useEffect(() => {
    if (!(node instanceof HTMLVideoElement)) return
    const sync = () => {
      if (node.readyState < HTMLMediaElement.HAVE_METADATA) return
      setAudioOnlyVideo(node.videoWidth === 0)
    }
    sync()
    node.addEventListener('loadedmetadata', sync)
    return () => node.removeEventListener('loadedmetadata', sync)
  }, [node])

  return (
    <div className={showMeter ? 'question-clip has-meter' : 'question-clip'} role="group" aria-label={label}>
      {kind === 'audio' ? (
        <audio ref={takeNode} src={url} data-live={live ? '1' : '0'} autoPlay={live} loop={live && !once} preload="auto" onEnded={onEnded} />
      ) : (
        <video
          ref={takeNode}
          src={url}
          data-live={live ? '1' : '0'}
          autoPlay={live}
          loop={live && !once}
          onEnded={onEnded}
          playsInline
          preload="auto"
        />
      )}
      {showMeter ? <QuestionMeter node={node} live={live} /> : null}
    </div>
  )
}

function mediaLabel(kind: 'image' | 'audio' | 'video', answer: boolean): string {
  if (kind === 'image') return answer ? 'Иллюстрация к ответу' : 'Иллюстрация к вопросу'
  if (kind === 'audio') return answer ? 'Звук ответа' : 'Звук вопроса'
  return answer ? 'Ролик ответа' : 'Ролик вопроса'
}

function itemLive(item: MediaItem, play: boolean, quiet?: ReadonlySet<string>): boolean {
  if (!play || item.kind === 'image' || !item.url) return false
  return !quiet?.has(item.url)
}
