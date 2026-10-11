import { getTrace, type ChatRole } from '../debug/trace.ts'
import type { ConferenceConversationLine } from './messages.ts'

export function readConversationLines(limit = 200): ConferenceConversationLine[] {
  const out: ConferenceConversationLine[] = []
  for (const entry of getTrace()) {
    if (entry.kind !== 'chat') continue
    const role = chatRole(entry.detail)
    const text = chatText(entry.detail)
    if (!text) continue
    out.push({ role, text })
  }
  return out.slice(-limit)
}

function chatRole(detail: unknown): ChatRole {
  if (detail && typeof detail === 'object' && 'role' in detail) {
    const role = (detail as { role?: unknown }).role
    if (role === 'host' || role === 'player' || role === 'judge') return role
  }
  return 'host'
}

function chatText(detail: unknown): string {
  if (detail && typeof detail === 'object' && 'text' in detail && typeof (detail as { text: unknown }).text === 'string') {
    return (detail as { text: string }).text.trim()
  }
  return ''
}
