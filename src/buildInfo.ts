export function buildCommit(): string {
  if (typeof __AISIGAME_COMMIT__ === 'string' && __AISIGAME_COMMIT__) return __AISIGAME_COMMIT__
  return 'dev'
}

export function pageOrigin(): string {
  if (typeof location === 'undefined') return ''
  return location.origin
}
