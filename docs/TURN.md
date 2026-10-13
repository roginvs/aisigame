# TURN-сервер (coturn) на fallout-nevada.ru

Нужен, когда у игроков строгий NAT или режут UDP: тогда звук/видео Jitsi и канал пакета (`src/conference/packPipe.ts`) идут через relay.

Порт 3478 (UDP и TCP) и диапазон relay UDP 49160–49200 должны быть открыты в файрволе. 443 занят nginx, поэтому TURN на 3478.

## 1. Запуск coturn

`SECRET` — общий static-auth-secret. Тот же секрет идёт в `.env` Jitsi. Логин/пароль в `packPipe.ts` выведены из него (username `4102444800:aisigame`, credential = base64(HMAC-SHA1(SECRET, username))). При смене секрета пересчитать:

```bash
printf '%s' '4102444800:aisigame' | openssl dgst -binary -sha1 -hmac "$SECRET" | base64
```

```bash
docker run -d --name coturn --restart unless-stopped --network host coturn/coturn \
  -n --log-file=stdout --listening-port=3478 \
  --external-ip=$(curl -4 -s ifconfig.me) \
  --min-port=49160 --max-port=49200 \
  --use-auth-secret --static-auth-secret="$SECRET" \
  --realm=fallout-nevada.ru --fingerprint --no-cli --no-tls --no-dtls \
  --no-multicast-peers --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 --denied-peer-ip=192.168.0.0-192.168.255.255
```

Файрвол (ufw):

```bash
ufw allow 3478/udp && ufw allow 3478/tcp && ufw allow 49160:49200/udp
```

## 2. Jitsi

В `.env` docker-jitsi-meet:

```bash
TURN_HOST=fallout-nevada.ru
TURN_PORT=3478
TURN_TRANSPORT=udp
TURN_CREDENTIALS=<SECRET>
```

Затем в каталоге docker-jitsi-meet `docker compose up -d` (или `docker-compose up -d`). Проверка: в консоли браузера пропадает `getting turn credentials failed`.

## Проверка

`docker logs coturn` — строки `listener opened`. Снаружи: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ с `turn:fallout-nevada.ru:3478`, username/credential из `packPipe.ts`, должна появиться строка `relay`.
