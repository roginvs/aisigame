import { useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'

export function InviteDialog(props: {
  url: string
  onCopy: () => Promise<boolean>
  onClose: () => void
}) {
  const { url, onCopy, onClose } = props
  const dialogRef = useRef<HTMLDialogElement>(null)
  const copiedTimer = useRef(0)
  const [qrUrl, setQrUrl] = useState('')
  const [qrError, setQrError] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    let active = true
    void toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#111923', light: '#ffffff' },
    }).then(
      (dataUrl) => {
        if (active) setQrUrl(dataUrl)
      },
      () => {
        if (active) setQrError(true)
      },
    )
    return () => {
      active = false
    }
  }, [url])

  useEffect(
    () => () => {
      window.clearTimeout(copiedTimer.current)
    },
    [],
  )

  async function copyLink(): Promise<void> {
    if (!(await onCopy())) return
    setCopied(true)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2_000)
  }

  return (
    <dialog
      ref={dialogRef}
      className="invite-dialog"
      aria-labelledby="invite-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="invite-dialog-card">
        <h2 id="invite-dialog-title">Ссылка для игры</h2>
        <p>Покажите QR-код игрокам или отправьте им ссылку.</p>
        <div className="invite-qr" aria-live="polite">
          {qrUrl ? <img src={qrUrl} alt="QR-код ссылки для игры" /> : null}
          {!qrUrl && !qrError ? <span>Готовим QR-код…</span> : null}
          {qrError ? <span className="error">QR-код не сгенерировался</span> : null}
        </div>
        <label className="field invite-url-field">
          <span>Ссылка</span>
          <input
            aria-label="Ссылка для игроков"
            value={url}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
        </label>
        <div className="invite-dialog-actions">
          <button type="button" className="primary invite-copy" onClick={() => void copyLink()}>
            <span className="invite-copy-label">
              <span className={copied ? 'invite-copy-hidden' : undefined} aria-hidden={copied}>
                Скопировать ссылку
              </span>
              <span className={copied ? undefined : 'invite-copy-hidden'} aria-hidden={!copied}>
                Скопировано
              </span>
            </span>
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </section>
    </dialog>
  )
}
