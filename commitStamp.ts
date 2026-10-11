import { execSync } from 'node:child_process'

export function commitStamp(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return hash || 'dev'
  } catch {
    return 'dev'
  }
}

export function commitDate(): string {
  try {
    const timestamp = execSync('git log -1 --format=%cI', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return timestamp ? timestamp.slice(0, 19).replace('T', ' ') : 'unknown'
  } catch {
    return 'unknown'
  }
}
