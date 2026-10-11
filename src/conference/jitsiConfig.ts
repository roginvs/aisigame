export type JitsiHosts = {
  domain: string
  muc: string
  focus: string
}

export function parseJitsiConfigJs(text: string): JitsiHosts {
  const domain = quotedField(text, 'domain') ?? 'meet.jitsi'
  const mucRaw = quotedField(text, 'muc')
  const focusRaw = quotedField(text, 'focus')
  return {
    domain,
    muc: mucRaw ?? `muc.${domain}`,
    focus: focusRaw ?? `focus.${domain}`,
  }
}

function quotedField(text: string, key: string): string | null {
  const re = new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`)
  const match = re.exec(text)
  return match?.[1]?.trim() ?? null
}

export function websocketUrlForBase(jitsiBase: string): string {
  const url = new URL(jitsiBase.replace(/\/+$/, '') + '/xmpp-websocket')
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else url.protocol = 'wss:'
  return url.href
}

export async function fetchJitsiConfig(jitsiBase: string): Promise<JitsiHosts> {
  const base = jitsiBase.replace(/\/+$/, '')
  const response = await fetch(`${base}/config.js`)
  if (!response.ok) throw new Error('Не удалось прочитать config.js сервера Jitsi')
  const text = await response.text()
  return parseJitsiConfigJs(text)
}
