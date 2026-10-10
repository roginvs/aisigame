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

В уже существующий `server` с сертификатом `fallout-nevada.ru`. Префикс `/jitsi` снимается: контейнер ждёт пути от корня. Более конкретные `location` стоят выше общего.

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

Проверка: `curl -s http://127.0.0.1:8000/config.js` содержит `config.hosts.domain = 'meet.jitsi'`. Снаружи открываются `https://fallout-nevada.ru/jitsi/config.js` и `https://fallout-nevada.ru/jitsi/libs/lib-jitsi-meet.min.js`. Страница Meet по адресу `/jitsi/` может открываться криво. Игра её не открывает.
