# Релей DashScope для aisigame

У DashScope нет ни CORS-заголовков у WebRTC SDP-обмена, ни ключа в параметрах
адреса у WebSocket — прямой вызов из браузера их сервер отклоняет (проверено
21–22 октября 2026: `POST` и `OPTIONS` на
`https://{workspace}.{регион}.maas.aliyuncs.com/api/v1/webrtc/realtime` отвечают
быстро, но без `Access-Control-Allow-Origin`; ключ в аргументах адреса WebSocket
сервер игнорирует — «No API-key provided»). Этот маленький релей пересылает
только обмен SDP (`POST` на `https://*.maas.aliyuncs.com`) и добавляет
недостающий CORS.

Ключ никуда не записывается: каждый игрок вводит его у себя в браузере, и релей
лишь пересылает его в тот же запрос (заголовок `Authorization`). Для игры со
своего компьютера достаточно dev-релея внутри `npm run dev` (`/qwen-relay`,
мидлварь в `vite.config.ts`), для сайта на github.io нужен свой Worker.

## Развёртывание своего Worker (10 минут)

1. **Аккаунт Cloudflare** — https://dash.cloudflare.com/sign-up
   (бесплатно; бесплатного лимита в 100 000 запросов в сутки хватает с
   большим запасом — один запрос релея расходуется на одно подключение к голосу).

2. **Инструменты репозитория.** Wrangler уже лежит в `devDependencies`
   (`package.json`), общая установка для всего репозитория:

   ```bash
   npm install
   ```

3. **Вход в Cloudflare** (код можно подтвердить с телефона — к компу
   подходить не обязательно):

   ```bash
   cd relay
   npx wrangler login --device
   ```

   wrangler напечатает адрес `https://dash.cloudflare.com/oauth2/device/verify`
   и короткий код. Открой адрес на любом устройстве, введи код, нажми
   **Authorize**. В терминале появится `Successfully logged in`.

4. **Деплой из каталога `relay/`:**

   ```bash
   npx wrangler deploy
   ```

   В конце напечатает адрес вида

   ```
   https://aisigame-qwen-relay.<твой-поддомен>.workers.dev
   ```

   Поддомен `<твой-поддомен>.workers.dev` каждый аккаунт выбирает один раз.
   Если wrangler напишет «Could not automatically register … subdomain …» —
   зайди в панель Cloudflare (Workers & Pages → Enable workers.dev), выбери
   свободное имя поддомена и запусти `npx wrangler deploy` ещё раз; сертификат
   для нового поддомена выдаётся пару минут — если TLS не открывается сразу,
   подожди и повтори проверку (ниже).

5. **Вписать адрес в игру.** На стартовом экране выбрать модель
   Qwen Omni Realtime Flash, заполнить ключ DashScope, адрес workspace
   (можно только id, регион будет Пекин; для Сингапура — полный хост) и в поле
   **«Адрес релея»** вставить адрес из шага 4. Пустое поле релея означает
   прямой вызов из браузера — на сайте он упрётся в CORS с внятной ошибкой.

## Проверка релея без ключа

Болванка ключа должна пройти насквозь и вернуться ошибкой DashScope — это
доказывает, что пересылка работает:

```bash
R=https://aisigame-qwen-relay.<твой-поддомен>.workers.dev/qwen-relay
T=https://ws-<id>.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime

# preflight должен вернуть 204 и заголовки access-control-allow-*
curl -sS -i -X OPTIONS "$R" -H 'Origin: https://roginvs.github.io'

# пересылка: 401 InvalidApiKey от DashScope + access-control-allow-origin
curl -sS -i -X POST "$R" \
  -H "X-Qwen-Target: $T" \
  -H 'Authorization: Bearer dummy-not-a-real-key' \
  -H 'Content-Type: application/sdp' \
  --data-binary $'v=0\r\n'

# чужой хост должен быть отсечён (400)
curl -sS -X POST "$R" -H 'X-Qwen-Target: https://evil.example.com/x' \
  -H 'Authorization: Bearer dummy' --data-binary v=0
```

## Как это работает

- Клиент игры шлёт `POST {адрес релея}/qwen-relay`: ключ в `Authorization`,
  полный адрес DashScope в `X-Qwen-Target`, SDP-оффер в теле.
- Релей проверяет, что цель — `https://` и хост на `*.maas.aliyuncs.com`
  (открытого прокси из него не сделать), пересылает запрос и возвращает ответ,
  добавив `Access-Control-Allow-Origin`.
- Ответ DashScope (SDP-ответ) идёт в игру как при прямом вызове.
- Дальше всё соединение (WebRTC-медиа и каналы событий) идёт напрямую между
  браузерами и DashScope — релей используется только на обмен SDP.

## Развёрнутый экземпляр автора

22 октября 2026 развёрнут Worker `aisigame-qwen-relay` на поддомене
`roginvs` — `https://aisigame-qwen-relay.roginvs.workers.dev`. Он без ключей,
может служить примером; каждому стоит поднять свой, чтобы не зависеть от чужой
квоты.
