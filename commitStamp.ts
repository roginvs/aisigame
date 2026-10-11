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
    const date = execSync('git log -1 --format=%cs', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return date || 'unknown'
  } catch {
    return 'unknown'
  }
}
