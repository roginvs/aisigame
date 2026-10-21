# Релей DashScope для aisigame

У DashScope нет ни CORS-заголовков у WebRTC SDP-обмена, ни ключа в параметрах
адреса у WebSocket — прямой вызов из браузера их сервер отклоняет. Этот маленький
релей пересылает только обмен SDP (`POST` на `https://*.maas.aliyuncs.com`) и
добавляет недостающий CORS.

Ключ никуда не записывается: каждый игрок вводит его у себя в браузере, и релей
лишь пересылает его в тот же запрос (заголовок `Authorization`). Для игры со
своего компьютера достаточно dev-релея внутри `npm run dev` (`/qwen-relay`,
мидлварь в `vite.config.ts`).

## Зачем Worker

Для игры через https://roginvs.github.io/aisigame/ — GitHub Pages статический,
релея там нет. Свой Worker поднимается бесплатно за пару минут.

Как играть через Worker: в списке моделей выбрать Qwen Omni Realtime Flash,
заполнить ключ и адрес workspace, а в поле «Адрес релея» вписать адрес своего
Worker (можно только хост — `имя.workers.dev` — или полный адрес с `/qwen-relay`).

## Деплой

1. Аккаунт Cloudflare (бесплатный): https://dash.cloudflare.com/sign-up
2. Выполнить в каталоге `relay/`:

   ```bash
   npm install -g wrangler
   wrangler login
   wrangler deploy
   ```

3. `wrangler deploy` в конце напечатает адрес вида
   `https://aisigame-qwen-relay.<ваш-поддомен>.workers.dev` — его и вписать в поле
   «Адрес релея» на стартовом экране игры.

## Как это работает

- Клиент игры шлёт `POST {адрес релея}/qwen-relay`: ключ в `Authorization`,
  полный адрес DashScope в `X-Qwen-Target`, SDP-оффер в теле.
- Релей проверяет, что цель — `https://` и хост на `*.maas.aliyuncs.com`
  (открытого прокси из него не сделать), пересылает запрос и возвращает ответ,
  добавив `Access-Control-Allow-Origin`.
- Ответ DashScope (SDP-ответ) идёт в игру как при прямом вызове.
