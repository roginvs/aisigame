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
