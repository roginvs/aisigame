import { useEffect, useRef } from 'react'
import type { QuestionMedia as MediaItem } from '../game/types.ts'

export function QuestionMedia(props: { media: MediaItem[]; play: boolean; quiet?: ReadonlySet<string> }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { media, play, quiet } = props
  const liveKey = media.map((item) => (itemLive(item, play, quiet) ? '1' : '0')).join('')

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    for (const node of root.querySelectorAll<HTMLMediaElement>('audio, video')) {
      if (node.dataset.live === '1') void node.play().catch(() => undefined)
      else node.pause()
    }
  }, [liveKey, media])

  if (!media.length) return null
  return (
    <div className="question-media" ref={rootRef}>
      {media.map((item) => {
        if (!item.url) return <p key={item.name}>Файл не найден: {item.name}</p>
        const live = itemLive(item, play, quiet)
        if (item.kind === 'image') return <img key={item.url} src={item.url} alt="" />
        if (item.kind === 'audio') {
          return <audio key={item.url} src={item.url} data-live={live ? '1' : '0'} controls preload="auto" />
        }
        return <video key={item.url} src={item.url} data-live={live ? '1' : '0'} controls playsInline preload="auto" />
      })}
    </div>
  )
}

function itemLive(item: MediaItem, play: boolean, quiet?: ReadonlySet<string>): boolean {
  if (!play || item.kind === 'image' || !item.url) return false
  return !quiet?.has(item.url)
}
