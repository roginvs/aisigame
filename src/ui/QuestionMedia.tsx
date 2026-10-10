import { useCallback, useEffect, useRef } from 'react'
import type { QuestionMedia as MediaItem } from '../game/types.ts'
import { applyQuestionClip } from './questionClip.ts'

export function QuestionMedia(props: { media: MediaItem[]; play: boolean; quiet?: ReadonlySet<string> }) {
  const { media, play, quiet } = props
  if (!media.length) return null
  return (
    <div className="question-media">
      {media.map((item) => {
        if (!item.url) return <p key={item.name}>Файл не найден: {item.name}</p>
        const live = itemLive(item, play, quiet)
        if (item.kind === 'image') return <img key={item.url} src={item.url} alt="" />
        return <QuestionClip key={item.url} kind={item.kind} url={item.url} live={live} />
      })}
    </div>
  )
}

/** Звук или ролик без кнопок плеера: сам стартует и крутится, пока `live`. */
export function QuestionClip(props: { kind: 'audio' | 'video'; url: string; live: boolean }) {
  const { kind, url, live } = props
  const nodeRef = useRef<HTMLMediaElement | null>(null)
  const setNode = useCallback((node: HTMLMediaElement | null) => {
    nodeRef.current = node
  }, [])

  useEffect(() => {
    const node = nodeRef.current
    if (node) applyQuestionClip(node, live)
  }, [live, url])

  if (kind === 'audio') {
    return (
      <audio ref={setNode} src={url} data-live={live ? '1' : '0'} autoPlay={live} loop={live} preload="auto" />
    )
  }
  return (
    <video
      ref={setNode}
      src={url}
      data-live={live ? '1' : '0'}
      autoPlay={live}
      loop={live}
      playsInline
      preload="auto"
    />
  )
}

function itemLive(item: MediaItem, play: boolean, quiet?: ReadonlySet<string>): boolean {
  if (!play || item.kind === 'image' || !item.url) return false
  return !quiet?.has(item.url)
}
