# TURN-сервер (coturn) на fallout-nevada.ru

## Зачем он нужен

TURN нужен только для канала, по которому передаётся пакет (`src/conference/packPipe.ts`). Звук и видео Jitsi идут через свой видеомост (JVB, UDP 10000), им TURN не нужен. Если TURN не работает, пакет через 30 секунд всё равно уйдёт через Jitsi, просто медленнее.

Всё ниже выполняется на сервере fallout-nevada.ru под root, по порядку. Каждый блок копируется целиком.

## Шаг 1. Проверить, что есть Docker

```bash
docker --version || (curl -fsSL https://get.docker.com | sh)
```

## Шаг 2. Открыть порты

Если стоит ufw:

```bash
ufw allow 3478/udp; ufw allow 3478/tcp; ufw allow 49160:49200/udp; ufw status
```

Если у хостера есть свой файрвол в панели, там тоже открыть 3478 UDP+TCP и 49160–49200 UDP.

## Шаг 3. Запустить coturn

Секрет уже вписан. Пароль в `packPipe.ts` посчитан именно из него, поэтому менять ничего не надо.

```bash
docker rm -f coturn 2>/dev/null; \
docker run -d --name coturn --restart unless-stopped --network host coturn/coturn \
  -n --log-file=stdout --listening-port=3478 \
  --external-ip=$(curl -4 -s ifconfig.me) \
  --min-port=49160 --max-port=49200 \
  --use-auth-secret --static-auth-secret=08cf3274436761687fb3be3dd4456ab4216ed1826f865b21 \
  --realm=fallout-nevada.ru --fingerprint --no-cli --no-tls \
  --no-multicast-peers --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 --denied-peer-ip=192.168.0.0-192.168.255.255
```

## Шаг 4. Проверить, что запустился

```bash
sleep 3; docker ps --filter name=coturn; docker logs coturn 2>&1 | grep -i "listener opened" | head
```

Должен быть контейнер в статусе `Up` и несколько строк `listener opened`.

## Шаг 5. Проверить снаружи (с любого компьютера)

1. Открыть [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
2. STUN or TURN URI: `turn:fallout-nevada.ru:3478`
3. TURN username: `4102444800:aisigame`
4. TURN password: `sNgOnTytKaMZseeWPmUAl780Kb8=`
5. Add Server, затем Gather candidates. Должна появиться строка с типом `relay`. Если её нет, значит закрыты порты (шаг 2).

## Jitsi трогать не нужно

Jitsi в TURN не нуждается. Если всё же захочешь его подключить, в `.env` docker-jitsi-meet добавляются строки ниже, затем `docker compose up -d` в каталоге Jitsi:

```bash
TURN_HOST=fallout-nevada.ru
TURN_PORT=3478
TURN_TRANSPORT=udp
TURN_CREDENTIALS=08cf3274436761687fb3be3dd4456ab4216ed1826f865b21
```

## Если когда-нибудь менять секрет

Новый секрет подставить в шаг 3, и пересчитать пароль для `packPipe.ts`:

```bash
printf '%s' '4102444800:aisigame' | openssl dgst -binary -sha1 -hmac 'НОВЫЙ_СЕКРЕТ' | base64
```
