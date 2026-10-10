import { useEffect, useRef } from 'react'
import type { QuestionMedia as MediaItem } from '../game/types.ts'

export function QuestionMedia(props: { media: MediaItem[]; play: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { media, play } = props

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    for (const node of root.querySelectorAll<HTMLMediaElement>('audio, video')) {
      if (play) void node.play().catch(() => undefined)
      else node.pause()
    }
  }, [play, media])

  if (!media.length) return null
  return (
    <div className="question-media" ref={rootRef}>
      {media.map((item) => {
        if (!item.url) return <p key={item.name}>Файл не найден: {item.name}</p>
        if (item.kind === 'image') return <img key={item.url} src={item.url} alt="" />
        if (item.kind === 'audio') return <audio key={item.url} src={item.url} controls preload="auto" />
        return <video key={item.url} src={item.url} controls playsInline preload="auto" />
      })}
    </div>
  )
}
