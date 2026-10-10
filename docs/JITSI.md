# Сервер Jitsi

План партии, которая к этому серверу подключится, лежит в [ONLINE.md](ONLINE.md).

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

В уже существующий `server` с сертификатом `fallout-nevada.ru`. Старые `location` на `/jitsi` из этого `server` убрать и вставить блок ниже целиком. Префикс `/jitsi` снимается: контейнер ждёт пути от корня.

Одного общего `location /jitsi/` мало. Он отдаёт страницу, `config.js` и библиотеку, но заголовки `Upgrade` и `Connection` до Prosody не доходят. Игре нужны отдельные `location` для websocket и для канала моста, с этими двумя заголовками.

```nginx
location = /jitsi/xmpp-websocket {
    proxy_pass http://127.0.0.1:8000/xmpp-websocket;
    proxy_http_version 1.1;
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
    proxy_http_version 1.1;
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
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /jitsi/ {
    proxy_pass http://127.0.0.1:8000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

После вставки:

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

В тексте есть четыре строки:

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
