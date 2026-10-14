# Сервер Jitsi

Реализованное подключение приложения описано в [ONLINE.md](ONLINE.md).

Игре нужен адрес `https://fallout-nevada.ru/jitsi`. Сертификат уже на nginx этого хоста. Веб-контейнер слушает только `127.0.0.1:8000`. Звук и видео идут мимо nginx, по UDP 10000.

Официальный запуск — один `docker compose`: он сам поднимает web, prosody, jicofo и jvb. Четыре ручных `docker run` не нужны. Ветку `master` не клонируем. Руководство Jitsi прямо говорит, что `master` собран под нестабильные образы и с релизными не стыкуется. Клонируем последний тег `stable-*`.

```bash
tag=$(git ls-remote --tags --refs https://github.com/jitsi/docker-jitsi-meet.git 'stable-*' | awk -F/ '{print $NF}' | sort -V | tail -1)
git clone --depth 1 --branch "$tag" https://github.com/jitsi/docker-jitsi-meet
cd docker-jitsi-meet
cp env.example .env
./gen-passwords.sh
```

С релиза `stable-11146` контейнеры работают без root. Если каталогов нет или они чужие, контейнер не стартует и пишет об этом прямо. Каталоги создаём до первого запуска, как в руководстве:

```bash
mkdir -p ~/.jitsi-meet-cfg/{web,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri,transcriber}
mkdir -p ~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}
mkdir -p ~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}
chmod 777 ~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}
chmod 777 ~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}
```

Пароли, которые записал `gen-passwords.sh`, не меняем. В `.env` дописываем или заменяем строки:

```bash
PUBLIC_URL=https://fallout-nevada.ru/jitsi
JITSI_IMAGE_VERSION=<тот же тег, что в $tag>
HTTP_PORT=127.0.0.1:8000
HTTPS_PORT=127.0.0.1:8443
TZ=Europe/Moscow
JVB_ADVERTISE_IPS=<публичный IP сервера>
DISABLE_HTTPS=1
ENABLE_HTTP_REDIRECT=0
ENABLE_LETSENCRYPT=0
ENABLE_XMPP_WEBSOCKET=1
ENABLE_P2P=0
```

`PUBLIC_URL` без порта и без слэша на конце. `JITSI_IMAGE_VERSION` равен склонированному тегу. Если оставить пустым, текущий compose подставит `unstable`. `HTTP_PORT=127.0.0.1:8000` попадает в готовую строку `${HTTP_PORT}:8000`, поэтому порт остаётся на localhost и `docker-compose.yml` править не нужно. Так же закрываем `HTTPS_PORT`. `JVB_ADVERTISE_IPS` — адрес, куда игроки шлют звук и видео. Без него сигнализация есть, а медиа нет.

```bash
docker compose up -d
```

Если Docker отвечает `unknown shorthand flag: 'd' in -d` и отсылает к `docker --help`, подкоманды `compose` на сервере нет. Флаг `-d` («в фоне») читает сам `docker`, а у него такого флага нет. Проверьте `docker-compose version` и `docker compose version`. Если жива команда с дефисом, запускайте `docker-compose up -d`. Если не отвечает ни одна, на Ubuntu поставьте плагин и вернитесь к команде с пробелом:

```bash
apt-get update
apt-get install -y docker-compose-v2
docker compose up -d
```

Пакета `docker-compose-v2` может не быть. Тогда `apt-get install -y docker-compose` и снова команда с дефисом.

После правки `.env` команда та же. Каталог `~/.jitsi-meet-cfg` не удалять: там пароли и сертификаты XMPP. В файрволе наружу уже открытый 443 и UDP 10000. Порты 8000 и 8443 наружу не публикуем.

### Nginx

В уже существующий `server` с сертификатом `fallout-nevada.ru`. Старые `location` на `/jitsi` из этого `server` убрать и вставить блоки ниже. Префикс `/jitsi` снимается: контейнер ждёт пути от корня.

На запрос nginx выбирает ровно один `location`; «сначала общий, потом ещё один» не бывает. Общие заголовки и прокси задаёт внешний `location /jitsi/`, а узкие вложенные `location` внутри него перебивают только то, что им нужно: websocket, мост, BOSH, `OPTIONS` для `config.js`. Вложенный `location` сравнивается с полным URI (`/jitsi/xmpp-websocket`, не `/xmpp-websocket`). Свои `add_header` во вложенном не повторяем — наследуются с родителя. Стоит свой `add_header` во вложенном — родительские CORS пропадут. Свой `proxy_set_header` во вложенном сбрасывает наследованные proxy-заголовки: на websocket-локациях `Host` и `X-Forwarded-*` повторяем вместе с `Upgrade` и `Connection`.

Игра с другого origin делает `fetch('https://fallout-nevada.ru/jitsi/config.js')`: с локального dev (`http://127.0.0.1:5173` или `http://localhost:5173`) и с GitHub Pages (`https://roginvs.github.io`). Без `Access-Control-Allow-Origin` браузер режет ответ. Prosody и веб-контейнер уже отдают этот заголовок на `xmpp-websocket`, `http-bind` и `lib-jitsi-meet.min.js`; у `config.js` его нет. Два одинаковых заголовка в одном ответе браузер тоже отвергает. На внешнем `location /jitsi/` один раз: `proxy_hide_header Access-Control-Allow-Origin;`, затем свой `add_header Access-Control-Allow-Origin $jitsi_cors always;` и `add_header Vary Origin always;` — так и `config.js`, и библиотека, и HTTP-ответ websocket получают ровно одну строку allow.

Websocket: браузер для `wss` не смотрит на `Access-Control-Allow-Origin`; нужны `101 Switching Protocols` и `Sec-WebSocket-Protocol: xmpp`. Заголовок CORS всё равно не должен дублироваться — его заменяет тот же блок на родителе.

Перед `server` с `fallout-nevada.ru`, в контексте `http { }`, **рядом с другими `server`, не внутри `server`**, вставьте `map`:

```nginx
map_hash_bucket_size 64;
map $http_origin $jitsi_cors {
    default "";
    "http://127.0.0.1:5173" $http_origin;
    "http://localhost:5173" $http_origin;
    "https://roginvs.github.io" $http_origin;
    "https://dev.fallout-nevada.ru" $http_origin;
}
```

Пустой `default` — чужой `Origin` не получает allow. В `server` — один внешний блок (отдельный `location = /jitsi/config.js` снаружи не нужен):

```nginx
location /jitsi/ {
    proxy_pass http://127.0.0.1:8000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_hide_header Access-Control-Allow-Origin;
    add_header Access-Control-Allow-Origin $jitsi_cors always;
    add_header Vary Origin always;

    location = /jitsi/config.js {
        if ($request_method = OPTIONS) {
            return 204;
        }
        proxy_pass http://127.0.0.1:8000/config.js;
    }

    location = /jitsi/xmpp-websocket {
        proxy_pass http://127.0.0.1:8000/xmpp-websocket;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 900s;
        tcp_nodelay on;
    }

    location /jitsi/colibri-ws/ {
        proxy_pass http://127.0.0.1:8000/colibri-ws/;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 900s;
        tcp_nodelay on;
    }

    location /jitsi/http-bind {
        proxy_pass http://127.0.0.1:8000/http-bind;
    }
}
```

У вложенного `location = /jitsi/config.js` своих `add_header` нет: на GET и на `return 204` для `OPTIONS` с родителя наследуются CORS-строки с `always`. После правки конфига:

```bash
nginx -t && systemctl reload nginx
```

### Проверки

Игре нужны `config.js`, библиотека и websocket. Страницу Meet она не открывает. Команды ниже годятся с любой машины, кроме тех, где написано «на сервере».

Контейнеры на сервере. В `docker ps` четыре строки: web, prosody, jicofo, jvb. У web порт `127.0.0.1:8000->8000/tcp`, не `0.0.0.0:8000`. У jvb есть `0.0.0.0:10000->10000/udp`. Порты 8000 и 8443 снаружи не публикуются. UDP 10000 в файрволе открыт: звук и видео идут мимо nginx, и `curl` этот порт не проверяет.

Страница. `curl -sI https://fallout-nevada.ru/jitsi/` начинается с `HTTP/1.1 200`. В браузере она без стилей: в HTML стоит `<base href="/">`, поэтому стили запрашиваются с корня сайта. `curl -sI https://fallout-nevada.ru/jitsi/css/all.css` даёт `200`, а `https://fallout-nevada.ru/css/all.css` даёт `404`. Так и должно быть.

`config.js`:

```bash
curl -fsS https://fallout-nevada.ru/jitsi/config.js
```

CORS для игры с другого origin — ровно одна строка allow, без дубликата:

```bash
curl -sI -H 'Origin: http://127.0.0.1:5173' https://fallout-nevada.ru/jitsi/config.js | grep -i access-control-allow-origin
```

Должно вывести одну строку: `access-control-allow-origin: http://127.0.0.1:5173`. То же с `-H 'Origin: https://roginvs.github.io'` — одна строка `access-control-allow-origin: https://roginvs.github.io`. Две строки с одним именем заголовка, пустой allow или его нет — `map` не в `http { }`, не сработал `proxy_hide_header`, или конфиг не перезагружен: `nginx -t && systemctl reload nginx`.

В тексте должны быть следующие назначения:

```javascript
config.hosts.domain = 'meet.jitsi';
config.bosh = 'https://fallout-nevada.ru/jitsi/' + subdir + 'http-bind';
config.websocket = 'wss://fallout-nevada.ru/jitsi/' + subdir + 'xmpp-websocket';
```

И в `config.p2p` стоит `enabled: false`. Домен `meet.jitsi` внутренний. Публичный адрес игры — `https://fallout-nevada.ru/jitsi`. Та же проверка на сервере: `curl -fsS http://127.0.0.1:8000/config.js`.

Библиотека. `curl -sI https://fallout-nevada.ru/jitsi/libs/lib-jitsi-meet.min.js` даёт `200` и `Content-Type: application/javascript`. Файл больше мегабайта. Начало файла — комментарий лицензии `lib-jitsi-meet.min.js`, не HTML страницы.

BOSH. `curl -s https://fallout-nevada.ru/jitsi/http-bind` даёт `200` и страницу «Prosody BOSH endpoint». Это запасной канал. Игра ходит по websocket.

Websocket. В запросе обязателен `Sec-WebSocket-Protocol: xmpp`: так открывает сокет `lib-jitsi-meet`. Первая строка — `101 Switching Protocols`, среди заголовков есть `Sec-WebSocket-Protocol: xmpp`.

```bash
curl -sD - -o /dev/null --max-time 5 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: xmpp' \
  https://fallout-nevada.ru/jitsi/xmpp-websocket
```

Без заголовка `Sec-WebSocket-Protocol: xmpp` Prosody отвечает `501 Not Implemented`, даже когда nginx и модуль websocket в порядке. `curl -I` здесь не годится: это метод HEAD, не рукопожатие.

Если снаружи не `101`, ту же команду запускают на сервере, подставив `http://127.0.0.1:8000/xmpp-websocket`. На localhost `101`, а снаружи другой код — в загруженный nginx не попал `location = /jitsi/xmpp-websocket`. Это видно так: `nginx -T | grep xmpp-websocket`. На localhost тоже нет `101`, хотя заголовок `xmpp` есть — смотреть контейнер web и Prosody, не публичный nginx. `501` без этого заголовка ни о чём не говорит.

### Консоль браузера: STUN/TURN

После успешного входа в XMPP `lib-jitsi-meet` спрашивает у Prosody список STUN/TURN (`urn:xmpp:extdisco:2`, затем `:1`). В `docker-jitsi-meet` модуль `external_services` поднимается только если в `.env` заданы `TURN_HOST` или `TURNS_HOST`. Без них Prosody отвечает `service-unavailable`, и в консоли красным:

```text
Strophe error: … "operation":"get STUN/TURN credentials (extdisco:2)" …
getting turn credentials with extdisco:2 failed, trying extdisco:1
getting turn credentials failed
is mod_turncredentials or similar installed and configured?
```

Это не nginx и не ошибка игры. Сигнализация уже жива: в том же логе есть `SASL authentication succeeded`, `Strophe connected` и Jabber ID. Для нашей схемы (JVB, `ENABLE_P2P=0`, открытый UDP 10000 и верный `JVB_ADVERTISE_IPS`) TURN не обязателен: медиа идёт на мост напрямую. Сообщение можно игнорировать, пока комната открывается и звук/видео доходят.

Готовая инструкция coturn: [TURN.md](TURN.md).

Если сигнализация есть, а медиа нет — сначала проверить `JVB_ADVERTISE_IPS` и UDP 10000 в файрволе, не TURN. Для Jitsi-медиа coturn может понадобиться, когда у игроков режут UDP к JVB (жёсткий NAT, сети «только TCP 443»). Тогда поднимают отдельный coturn и в `.env` рядом с остальными строками:

```bash
TURN_HOST=<хост coturn>
TURN_PORT=443
TURN_TRANSPORT=tcp
TURN_CREDENTIALS=<тот же static-auth-secret, что у coturn>
```

После правки — снова `docker compose up -d` (или `docker-compose up -d`). Пока coturn нет, эти переменные не добавлять: пустые значения ситуацию не улучшают.

Другие строки того же захода не чинят: `Analytics disabled` — мы сами отключили сторонние запросы; `Permissions policy violation: unload` — предупреждение Chromium внутри библиотеки, на вход в комнату не влияет.

`conference.joined` может прийти раньше готовности BridgeChannel. Если сразу после него библиотека пишет `BridgeChannel has not been initialized yet`, сервер уже не нужно перестраивать: приложение держит ранние endpoint-сообщения в очереди до `conference.dataChannelOpened`. Исправленная версия не должна вслед за этой строкой вызывать `ChatRoom doLeave` и `connection.disconnect`.

Ранний BridgeChannel проверяется из репозитория без ключа модели:

```bash
JITSI_LIVE=1 npx playwright test e2e/jitsi.live.play.ts
```

Первый сценарий поднимает двух настоящих анонимных клиентов в случайной комнате и отправляет endpoint-сообщение сразу после `conference.joined`. Второй проходит реальное Jitsi-лобби приложения, отдельного участника «Ведущая», передачу пакета, ready и старт. В приложении удалённый звук идёт через `<audio>`, которые клик входа разблокировал заранее: один Web Audio на телефоне молчит. Дорожка не теряется и при `TRACK_ADDED` раньше `USER_JOINED`. После собственного входа приложение дополнительно перечитывает публичную карту `conference.participants` и `participant.getTracks()`: события тех, кто уже был в комнате, могли пройти до установки наших обработчиков. Audio levels включены для пульсирующей рамки говорящего, но их частые React-обновления не перепривязывают видеотрек; камеры меняются через `replaceTrack`. Полный звук, цикл нескольких физических камер и отсутствие эха всё ещё проверяем вручную с двумя устройствами.

## Отдельный канал пакета приложения

TURN-настройки Prosody выше относятся к Jitsi-медиа. `src/conference/packPipe.ts` создаёт отдельный RTCPeerConnection с Google STUN; TURN от Jitsi туда автоматически не попадает. Поэтому успешный звук/видео не гарантирует доставку пакета в сети со строгим NAT. Настройка TURN для packPipe или резервная доставка — отдельная задача в to-do. Проверить CORS также с Origin `https://dev.fallout-nevada.ru`: этот туннель подставляет buildInviteUrl для локального 127.0.0.1.

Этот файл — инструкция, а не снимок работающего сервера. Фактический stable-тег, состав compose и ответы nginx нужно проверять на сервере перед изменениями; в этом аудите сервер не меняли.

## Звуки игры через конференцию (14 октября 2026)

На телефоне голос ведущей и игроков из Jitsi звучит тише локальных эффектов (Web Audio в динамик), поэтому в Jitsi-режиме эффекты идут тем же путём, что и голоса:

- Мастер, кроме своего участника и бота «Ведущая», подключает второго скрытого бота «Звуки игры» (`SOUNDS_JITSI_NAME`). Все эффекты (пи-пи-пи таймаута, мяуканье кота, гонг аукциона) мастер играет в `MediaStreamAudioDestinationNode` игрового AudioContext (`gameSoundStream()` в `audio/beep.ts`), поток публикуется дорожкой этого бота.
- Все, включая мастера, слышат эффекты из конференции (обычный `<audio>` удалённой дорожки); joiner в Jitsi локально эффекты не играет (`setGameSoundRoute("remote")`), мастер — только в поток. Двойного звука нет.
- «Звуки игры» не плитка, не игрок, не участвует в «кто-то говорит», не попадает в микс модели; в протоколе игры (ростер, лобби) его нет — бот не говорит app-протоколом.
- Без Jitsi (одиночная игра, broadcast-конференция) путь прежний — в динамик. В Jitsi локального запасного пути нет: если бот не подключился, отпал или публикация не удалась, эффекты молчат (`broken`), в debug trace пишется причина, а в «Разговоре» у всех один раз на сбой появляется ошибка «Ошибка: звук игры не проигрывается — участник «Звуки игры» не подключился.» (роль `error`, модели не передаётся). Новая попытка конференции снова может показать ошибку. Сбой бота комнату не роняет.
- Тайминги не зависят от маршрута: длительность пи-пи-пи — константа `buzzerBeepMs`, игра не ждёт события `ended`.
- Ограничение по умолчанию: joiner в Jitsi всегда ждёт эффекты из конференции; если у мастера бот не поднялся, joiner их не услышит.
- Демо: `window.__aisigame.playGameSound("beep" | "cat" | "auction")` играет эффект и возвращает маршрут (`local` / `stream` / `remote` / `broken`).
