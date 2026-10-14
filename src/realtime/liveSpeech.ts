/** Черновик виден, только если итоговая реплика тоже попала бы в чат сразу. */
export function livePlayerChatVisible(state: { suppressed: boolean; gated: boolean; echo: boolean }): boolean {
  return !state.suppressed && !state.gated && !state.echo
}

/**
 * Троттлинг рассылки черновика joiner-ам: первое и последнее значение уходят
 * всегда, промежуточные — не чаще раза в `intervalMs`.
 */
export function throttleLatest<T>(intervalMs: number, send: (value: T) => void, schedule = setTimeout, cancel = clearTimeout) {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  const flush = () => {
    timer = null
    if (!pending) return
    last = Date.now()
    const { value } = pending
    pending = null
    send(value)
  }
  return {
    push(value: T, immediate = false) {
      pending = { value }
      const wait = intervalMs - (Date.now() - last)
      if (immediate || wait <= 0) {
        if (timer !== null) cancel(timer)
        flush()
      } else if (timer === null) timer = schedule(flush, wait)
    },
    stop() {
      if (timer !== null) cancel(timer)
      timer = null
      pending = null
    },
  }
}
