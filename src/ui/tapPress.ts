import type { MouseEvent, PointerEvent } from 'react'

/**
 * Buzzer press for touch screens. On phones the players row scrolls horizontally, so a tap with a
 * slight finger movement turns into a pan and the browser never fires `click`. Touch/pen presses act
 * on `pointerdown`; the follow-up `click` (if any) is swallowed so one tap is one press. Mouse and
 * keyboard (Enter/Space on a focused button) keep using `click`.
 */
export function tapPressProps(action: () => void): {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
} {
  return {
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' || event.button !== 0 || event.currentTarget.disabled) return
      event.currentTarget.dataset.tapAt = String(Date.now())
      action()
    },
    onClick: (event) => {
      const tapAt = Number(event.currentTarget.dataset.tapAt ?? 0)
      delete event.currentTarget.dataset.tapAt
      if (tapAt && Date.now() - tapAt < 1_500) return
      action()
    },
  }
}
