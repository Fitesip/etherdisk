# Развёртывание в Docker

Три контейнера: **nginx** (HTTPS, etherdisk.app) → **web** (Next.js) и **server** (Rust, API на `/api/`).
Сайт и API на одном домене, поэтому CORS не нужен. Порядок выхода в mainnet — в `docs/LAUNCH.md`.

## 1. Подготовка хоста

- Docker с плагином compose (2.24.4 или новее), открыты порты 80 и 443 (если они заняты — см. «Порты 80 и 443 заняты»), DNS `etherdisk.app` и `www.etherdisk.app` указывают на хост.
- Папки для базы и томов (RAID-массивов). Сервер в контейнере работает от пользователя с UID 10001:

```bash
sudo mkdir -p /srv/etherdisk/db /mnt/raid1/etherdisk
sudo chown -R 10001:10001 /srv/etherdisk/db /mnt/raid1/etherdisk
```

- Если массив монтируется в `/mnt/raid1`, защитите пустую точку монтирования от записи **до** монтирования (`sudo chattr +i /mnt/raid1`): тогда без массива сервер не стартует, а не начнёт писать диски на системный раздел.

## 2. Настройки

```bash
cd deploy
cp .env.example .env               # адрес контракта, RPC, пути к базе и томам
cp server.env.example server.env   # CHAIN_ID, START_BLOCK, Telegram, модераторы
```

Несколько массивов: в `.env` — `VOLUME_2=...`, в `docker-compose.yml` под `server.volumes` — строка `- ${VOLUME_2}:/mnt/volume2`, в `server.env` — `DATA_DIR=/mnt/volume1,/mnt/volume2`.

## 3. Сертификат (первый раз)

nginx не запустится без сертификата, поэтому первый выпускает certbot сам, на порту 80:

```bash
docker compose run --rm -p 80:80 certbot certonly --standalone \
  -d etherdisk.app -d www.etherdisk.app --agree-tos -m <ваша почта> --no-eff-email
```

Продление (раз в день по cron; certbot сам решает, пора ли):

```bash
docker compose run --rm certbot renew --webroot -w /var/www/certbot && docker compose exec nginx nginx -s reload
```

## 4. Запуск и обновление

```bash
docker compose up -d --build      # первая сборка: ~10–20 минут (Rust и WASM)
docker compose logs -f server     # лог сервера: тома, мониторинг, индексатор
```

Обновление после `git pull`: снова `docker compose up -d --build`. `NEXT_PUBLIC_*` вшиваются в образ сайта при сборке: после их изменения нужна пересборка.

## Порты 80 и 443 заняты

Наружу открыт только nginx: сайт (3000) и API (8787) доступны лишь внутри сети compose. Другие порты для nginx — `HTTP_PORT` и `HTTPS_PORT` в `.env`.

Если 80 и 443 держит nginx, уже установленный на хосте, TLS остаётся у него, а он пересылает etherdisk.app в контейнеры:

1. В `deploy/.env`:

   ```
   COMPOSE_FILE=docker-compose.yml:behind-proxy.yml
   HTTP_PORT=127.0.0.1:8880
   ```

   nginx в контейнере тогда слушает только `127.0.0.1:8880`, без TLS (`nginx/etherdisk.behind-proxy.conf`). Порт можно взять любой свободный, но только на `127.0.0.1`: адрес клиента контейнер берёт из `X-Forwarded-For`.

2. `nginx/host-etherdisk.conf` скопировать в `/etc/nginx/sites-available/etherdisk.conf` и включить (порт в `proxy_pass` — тот же, что в `HTTP_PORT`). Пока сертификата нет, оставьте в нём только первый блок `server` (порт 80):

   ```bash
   sudo ln -s /etc/nginx/sites-available/etherdisk.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. Сертификат выпускает certbot хоста (шаг 3 с контейнерным certbot не нужен), потом верните в конфиг остальные блоки и снова `nginx -t` и `reload`:

   ```bash
   sudo mkdir -p /var/www/certbot
   sudo certbot certonly --webroot -w /var/www/certbot -d etherdisk.app -d www.etherdisk.app
   ```

   В этих блоках журнал пишется без IP-адресов, как обещает политика конфиденциальности.

4. `docker compose up -d --build` и проверка: `curl -I https://etherdisk.app`.

## Резервные копии

База — один файл SQLite в `DB_DIR` (плюс `-wal`/`-shm`). Копировать её на ходу — `sqlite3 etherdisk.db ".backup /куда/etherdisk.db"`. Тома с файлами защищает RAID, но не от удаления, пожара или ошибки контроллера: для них нужна отдельная копия.
