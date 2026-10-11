export function stripInviteParams(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('join')
  url.searchParams.delete('jitsi')
  const next = url.pathname + url.search + url.hash
  return next || '/'
}

export function jitsiHostFromBase(jitsiBase: string): string {
  try {
    return new URL(jitsiBase).host
  } catch {
    return jitsiBase
  }
}
