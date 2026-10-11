export function buildCommit(): string {
  if (typeof __AISIGAME_COMMIT__ === 'string' && __AISIGAME_COMMIT__) return __AISIGAME_COMMIT__
  return 'dev'
}

export function buildCommitDate(): string {
  if (typeof __AISIGAME_COMMIT_DATE__ === 'string' && __AISIGAME_COMMIT_DATE__) return __AISIGAME_COMMIT_DATE__
  return 'unknown'
}

export function startBuildInfo(): string {
  return import.meta.env.PROD ? `${buildCommitDate()} · ${buildCommit()}` : 'Режим разработки'
}

export function pageOrigin(): string {
  if (typeof location === 'undefined') return ''
  return location.origin
}
