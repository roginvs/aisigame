// Релей SDP-обмена с DashScope для aisigame.
//
// DashScope не отдаёт браузеру CORS-заголовки (проверено 21 октября 2026), а их
// WebSocket требует ключ в заголовке рукопожатия, который браузерный WebSocket
// ставить не умеет. Прямой вызов из страницы отказал, поэтому обмен SDP идёт
// через этот Worker: браузер шлёт POST с адресом цели в заголовке X-Qwen-Target,
// Worker пересылает его на https://*.maas.aliyuncs.com и добавляет CORS.
//
// Ключ здесь не хранится: каждый игрок передаёт свой ключ из браузера в заголовке
// Authorization, Worker лишь пересылает его в тот же запрос. Пересылать можно
// только на https://*.maas.aliyuncs.com — открытого прокси из Worker не сделать.
//
// Деплой — relay/README.md.

const HOST_SUFFIX = '.maas.aliyuncs.com'

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Qwen-Target',
    'Access-Control-Max-Age': '86400',
  }
}

function fail(status, message, origin) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) },
  })
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin')
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }
    if (request.method !== 'POST') {
      return fail(405, 'Релей понимает только POST', origin)
    }
    let target
    try {
      target = new URL(request.headers.get('X-Qwen-Target') || '')
    } catch {
      return fail(400, 'В запросе нет адреса X-Qwen-Target', origin)
    }
    if (target.protocol !== 'https:' || !target.hostname.endsWith(HOST_SUFFIX)) {
      return fail(400, `Релей пересылает только на https://*${HOST_SUFFIX}`, origin)
    }
    const authorization = request.headers.get('Authorization') || ''
    if (!authorization.startsWith('Bearer ')) {
      return fail(400, 'Нет ключа в заголовке Authorization', origin)
    }
    try {
      const upstream = await fetch(target.toString(), {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': request.headers.get('Content-Type') || 'application/sdp',
        },
        body: await request.arrayBuffer(),
      })
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8',
          ...corsHeaders(origin),
        },
      })
    } catch {
      return fail(502, 'DashScope не ответил', origin)
    }
  },
}
