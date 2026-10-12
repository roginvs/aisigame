import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConferenceTile } from '../conference/media.ts'

/** Кадр участника без кнопок mic/cam — они в подвале чата. */
export function ConferenceVideoTile(props: {
  tile: ConferenceTile
  bindVideo: (participantId: string, element: HTMLVideoElement | null) => void
  masterBadge?: boolean
  /**
   * Имя уже рядом (счёт / кнопка) — не пишем его ни в placeholder, ни в meta.
   * В лобби имя остаётся в кадре, в meta только «мастер» / «мик выкл.».
   */
  hideName?: boolean
}) {
  const { tile, bindVideo, masterBadge, hideName = false } = props
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const bindVideoRef = useRef(bindVideo)
  const name = tile.name.trim() || 'Игрок'
  const showNameInMeta = !hideName && tile.cameraOn
  const showMicOff = !tile.micLive
  const showMeta = showNameInMeta || Boolean(masterBadge) || showMicOff

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
      className={[
        'video-tile',
        tile.isLocal ? 'local' : '',
        tile.micLive ? 'mic-live' : 'mic-off',
        tile.speaking ? 'speaking' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="video-frame">
        {tile.cameraOn ? (
          <video ref={videoRef} autoPlay playsInline muted />
        ) : hideName ? (
          <span className="video-placeholder video-placeholder-muted">камера выкл.</span>
        ) : (
          <span className="video-placeholder">{name}</span>
        )}
        {showMeta ? (
          <div className="video-meta">
            {showNameInMeta ? <span className="video-name">{name}</span> : <span />}
            {masterBadge ? <span className="roster-tag">мастер</span> : null}
            {showMicOff ? <span className="video-mic-off" aria-label="Микрофон выключен">мик выкл.</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Локальные mic / cam / следующая камера — ряд над полем чата. */
export function ConferenceMediaControls(props: {
  micLive: boolean
  cameraOn: boolean
  mediaBusy?: boolean
  onToggleMic: () => void
  onToggleCamera: () => void
  onNextCamera: () => void
  /** Явно: есть ли >1 камеры. Без пропа — считаем через enumerateDevices. */
  canCycleCamera?: boolean
}) {
  const { micLive, cameraOn, mediaBusy, onToggleMic, onToggleCamera, onNextCamera, canCycleCamera } = props
  const [deviceCameras, setDeviceCameras] = useState(0)

  useEffect(() => {
    if (canCycleCamera !== undefined) return
    let cancelled = false
    async function refresh() {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) {
          if (!cancelled) setDeviceCameras(0)
          return
        }
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setDeviceCameras(devices.filter((device) => device.kind === 'videoinput' && device.deviceId).length)
      } catch {
        if (!cancelled) setDeviceCameras(0)
      }
    }
    void refresh()
    const media = navigator.mediaDevices
    media?.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      media?.removeEventListener?.('devicechange', refresh)
    }
  }, [canCycleCamera, cameraOn])

  const showNext = cameraOn && (canCycleCamera ?? deviceCameras > 1)

  return (
    <div
      className={['chat-media-controls', showNext ? 'with-next' : 'pair'].join(' ')}
      role="group"
      aria-label="Камера и микрофон"
    >
      <button
        type="button"
        className={micLive ? 'video-btn on' : 'video-btn'}
        disabled={mediaBusy}
        aria-pressed={micLive}
        aria-label={micLive ? 'Выключить микрофон' : 'Включить микрофон'}
        onClick={onToggleMic}
      >
        <MediaBtnIcon>{micLive ? <MicOnIcon /> : <MicOffIcon />}</MediaBtnIcon>
        <span>{micLive ? 'Микрофон' : 'Микрофон выкл.'}</span>
      </button>
      <button
        type="button"
        className={cameraOn ? 'video-btn on' : 'video-btn'}
        disabled={mediaBusy}
        aria-pressed={cameraOn}
        aria-label={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
        onClick={onToggleCamera}
      >
        <MediaBtnIcon>{cameraOn ? <CamOnIcon /> : <CamOffIcon />}</MediaBtnIcon>
        <span>{cameraOn ? 'Камера' : 'Камера выкл.'}</span>
      </button>
      {showNext ? (
        <button
          type="button"
          className="video-btn"
          disabled={mediaBusy}
          aria-label="Следующая камера"
          onClick={onNextCamera}
        >
          <MediaBtnIcon>
            <CamSwitchIcon />
          </MediaBtnIcon>
          <span>Следующая камера</span>
        </button>
      ) : null}
    </div>
  )
}

function MediaBtnIcon(props: { children: ReactNode }) {
  return (
    <span className="video-btn-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {props.children}
      </svg>
    </span>
  )
}

function MicOnIcon() {
  return (
    <>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 19v2" />
      <path d="M9 21h6" />
    </>
  )
}

function MicOffIcon() {
  return (
    <>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 19v2" />
      <path d="M9 21h6" />
      <path d="M4 4 20 20" />
    </>
  )
}

function CamOnIcon() {
  return (
    <>
      <rect x="3" y="7" width="13" height="10" rx="2" />
      <path d="M16 10.5 21 8v8l-5-2.5" />
    </>
  )
}

function CamOffIcon() {
  return (
    <>
      <rect x="3" y="7" width="13" height="10" rx="2" />
      <path d="M16 10.5 21 8v8l-5-2.5" />
      <path d="M4 4 20 20" />
    </>
  )
}

function CamSwitchIcon() {
  return (
    <>
      <path d="M7 8H4v3" />
      <path d="M4 8a7 7 0 0 1 12.2-3.5" />
      <path d="M17 16h3v-3" />
      <path d="M20 16a7 7 0 0 1-12.2 3.5" />
    </>
  )
}

/** @deprecated strip убран; оставлено для старых импортов тестов — собирает плитки без controls. */
export function ConferenceVideoStrip(props: {
  tiles: ConferenceTile[]
  bindVideo: (participantId: string, element: HTMLVideoElement | null) => void
  onToggleMic?: () => void
  onToggleCamera?: () => void
  onNextCamera?: () => void
  mediaBusy?: boolean
}) {
  const { tiles, bindVideo } = props
  return (
    <aside className="video-strip" aria-label="Участники">
      {tiles.map((tile) => (
        <ConferenceVideoTile key={tile.id} tile={tile} bindVideo={bindVideo} />
      ))}
    </aside>
  )
}
