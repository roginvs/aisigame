import { useEffect, useRef } from 'react'
import type { ConferenceTile } from '../conference/media.ts'

export function ConferenceVideoStrip(props: {
  tiles: ConferenceTile[]
  onToggleMic: () => void
  onToggleCamera: () => void
  onNextCamera: () => void
  bindVideo: (participantId: string, element: HTMLVideoElement | null) => void
  mediaBusy?: boolean
}) {
  const { tiles, onToggleMic, onToggleCamera, onNextCamera, bindVideo, mediaBusy } = props
  return (
    <aside className="video-strip" aria-label="Участники">
      {tiles.map((tile) => (
        <VideoTile
          key={tile.id}
          tile={tile}
          bindVideo={bindVideo}
          onToggleMic={tile.isLocal ? onToggleMic : undefined}
          onToggleCamera={tile.isLocal ? onToggleCamera : undefined}
          onNextCamera={tile.isLocal ? onNextCamera : undefined}
          mediaBusy={mediaBusy}
        />
      ))}
    </aside>
  )
}

function VideoTile(props: {
  tile: ConferenceTile
  bindVideo: (participantId: string, element: HTMLVideoElement | null) => void
  onToggleMic?: () => void
  onToggleCamera?: () => void
  onNextCamera?: () => void
  mediaBusy?: boolean
}) {
  const { tile, bindVideo, onToggleMic, onToggleCamera, onNextCamera, mediaBusy } = props
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const bindVideoRef = useRef(bindVideo)

  useEffect(() => {
    bindVideoRef.current = bindVideo
  }, [bindVideo])

  useEffect(() => {
    const node = videoRef.current
    const bind = bindVideoRef.current
    bind(tile.id, node)
    return () => bind(tile.id, null)
  }, [tile.id, tile.cameraOn])

  return (
    <div
      className={['video-tile', tile.micLive ? 'mic-live' : 'mic-off', tile.speaking ? 'speaking' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className="video-frame">
        {tile.cameraOn ? (
          <video ref={videoRef} autoPlay playsInline muted />
        ) : (
          <span className="video-placeholder">{tile.name.trim() || 'Игрок'}</span>
        )}
      </div>
      <div className="video-meta">
        <span className="video-name">{tile.name}</span>
        {!tile.micLive ? <span className="video-mic-off" aria-label="Микрофон выключен">мик выкл.</span> : null}
      </div>
      {tile.isLocal ? (
        <div className="video-controls">
          <button
            type="button"
            className={tile.micLive ? 'video-btn on' : 'video-btn'}
            disabled={mediaBusy}
            aria-pressed={tile.micLive}
            aria-label={tile.micLive ? 'Выключить микрофон' : 'Включить микрофон'}
            onClick={onToggleMic}
          >
            {tile.micLive ? 'Микрофон' : 'Микрофон выкл.'}
          </button>
          <button
            type="button"
            className={tile.cameraOn ? 'video-btn on' : 'video-btn'}
            disabled={mediaBusy}
            aria-pressed={tile.cameraOn}
            aria-label={tile.cameraOn ? 'Выключить камеру' : 'Включить камеру'}
            onClick={onToggleCamera}
          >
            {tile.cameraOn ? 'Камера' : 'Камера выкл.'}
          </button>
          {tile.cameraOn ? (
            <button
              type="button"
              className="video-btn"
              disabled={mediaBusy}
              aria-label="Следующая камера"
              onClick={onNextCamera}
            >
              Следующая камера
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
